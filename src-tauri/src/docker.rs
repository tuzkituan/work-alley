use crate::model::{ContainerPort, DockerService, DockerStatus};
use crate::toolchain::Toolchain;
use std::process::Stdio;
use std::time::Duration;

/// A dead socket makes `docker ps` block indefinitely. Without this ceiling the
/// services panel spins forever.
const PS_TIMEOUT: Duration = Duration::from_secs(3);

/// Never returns Err. Absence and breakage are states to render.
pub async fn status(tc: &Toolchain) -> DockerStatus {
    let Some(runtime) = tc.container_runtime() else {
        return DockerStatus::NotInstalled;
    };
    let Some(bin) = tc.path(runtime.tool()) else {
        return DockerStatus::NotInstalled;
    };

    let mut c = tokio::process::Command::new(bin);
    crate::platform::hide_console(&mut c);
    c.args(["ps", "--all", "--format", "{{json .}}"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return DockerStatus::NotInstalled,
        Err(e) => {
            return DockerStatus::DaemonDown {
                runtime,
                message: e.to_string(),
            }
        }
    };

    let out = match tokio::time::timeout(PS_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return DockerStatus::DaemonDown {
                runtime,
                message: e.to_string(),
            }
        }
        Err(_) => return DockerStatus::TimedOut { runtime },
    };

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return DockerStatus::DaemonDown {
            runtime,
            message: if stderr.is_empty() {
                "the container runtime is not responding".into()
            } else {
                stderr
            },
        };
    }

    DockerStatus::Ok {
        runtime,
        services: parse_ps(&String::from_utf8_lossy(&out.stdout)),
        fetched_unix: crate::git::now_unix(),
    }
}

/// One JSON object per line. A malformed line is skipped, never fatal.
pub fn parse_ps(stdout: &str) -> Vec<DockerService> {
    let mut out = Vec::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };

        let get = |k: &str| -> String {
            v.get(k)
                .and_then(|x| x.as_str())
                .unwrap_or_default()
                .to_string()
        };

        // docker uses "Names"; podman uses "Names" as an array in some versions.
        let name = match v.get("Names") {
            Some(serde_json::Value::Array(a)) => a
                .first()
                .and_then(|x| x.as_str())
                .unwrap_or_default()
                .to_string(),
            Some(serde_json::Value::String(s)) => s.clone(),
            _ => get("Name"),
        };

        let status = if !get("Status").is_empty() {
            get("Status")
        } else {
            get("State")
        };
        let state = {
            let s = get("State");
            if s.is_empty() {
                if status.starts_with("Up") {
                    "running".to_string()
                } else {
                    "exited".to_string()
                }
            } else {
                s
            }
        };

        out.push(DockerService {
            id: {
                let id = get("ID");
                if id.is_empty() {
                    get("Id")
                } else {
                    id
                }
            },
            name,
            image: get("Image"),
            state,
            uptime_seconds: parse_uptime(&status),
            ports: parse_ports(&get("Ports")),
            status,
        });
    }

    out
}

/// `"Up 3 hours"` -> 10800. None when unparseable — the raw string is always kept
/// so the UI can degrade to showing the runtime's own words.
pub fn parse_uptime(status: &str) -> Option<i64> {
    let rest = status.strip_prefix("Up ")?.trim();
    let mut it = rest.split_whitespace();
    let n: i64 = it.next()?.parse().ok()?;
    let unit = it.next()?;
    let mult = if unit.starts_with("second") {
        1
    } else if unit.starts_with("minute") {
        60
    } else if unit.starts_with("hour") {
        3_600
    } else if unit.starts_with("day") {
        86_400
    } else if unit.starts_with("week") {
        604_800
    } else if unit.starts_with("month") {
        2_592_000
    } else {
        return None;
    };
    Some(n * mult)
}

/// `"0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp"` deduped by (container, proto).
pub fn parse_ports(s: &str) -> Vec<ContainerPort> {
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();

    for part in s.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (host_side, container_side) = match part.split_once("->") {
            Some((h, c)) => (Some(h), c),
            None => (None, part),
        };

        let (cport, proto) = match container_side.split_once('/') {
            Some((p, pr)) => (p, pr),
            None => (container_side, "tcp"),
        };
        let Ok(container) = cport.trim().parse::<u16>() else {
            continue;
        };

        let host = host_side
            .and_then(|h| h.rsplit_once(':').map(|(_, p)| p.to_string()))
            .and_then(|p| p.parse::<u16>().ok());

        if seen.insert((container, proto.to_string())) {
            out.push(ContainerPort {
                host,
                container,
                proto: proto.to_string(),
            });
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_docker_json_lines() {
        let stdout = r#"{"ID":"abc123","Names":"mongo","Image":"mongo:7","State":"running","Status":"Up 4 hours","Ports":"0.0.0.0:27017->27017/tcp"}
{"ID":"def456","Names":"signoz","Image":"signoz:latest","State":"exited","Status":"Exited (1) 12 minutes ago","Ports":""}"#;
        let svcs = parse_ps(stdout);
        assert_eq!(svcs.len(), 2);
        assert_eq!(svcs[0].name, "mongo");
        assert_eq!(svcs[0].uptime_seconds, Some(4 * 3600));
        assert_eq!(svcs[0].ports[0].container, 27017);
        assert_eq!(svcs[0].ports[0].host, Some(27017));
        assert_eq!(svcs[1].state, "exited");
        assert_eq!(svcs[1].uptime_seconds, None);
    }

    #[test]
    fn podman_array_names() {
        let stdout = r#"{"Id":"x","Names":["redis"],"Image":"redis:7","State":"running","Status":"Up 2 minutes","Ports":"0.0.0.0:6379->6379/tcp"}"#;
        let svcs = parse_ps(stdout);
        assert_eq!(svcs[0].name, "redis");
        assert_eq!(svcs[0].uptime_seconds, Some(120));
    }

    #[test]
    fn malformed_line_is_skipped_not_fatal() {
        let stdout = "not json\n{\"Names\":\"ok\",\"Status\":\"Up 1 hour\"}\n";
        let svcs = parse_ps(stdout);
        assert_eq!(svcs.len(), 1);
        assert_eq!(svcs[0].name, "ok");
    }

    #[test]
    fn dedupes_ipv4_and_ipv6_ports() {
        let ports = parse_ports("0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp");
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].host, Some(5432));
    }

    #[test]
    fn unpublished_port_has_no_host() {
        let ports = parse_ports("9092/tcp");
        assert_eq!(ports.len(), 1);
        assert_eq!(ports[0].host, None);
        assert_eq!(ports[0].container, 9092);
    }
}
