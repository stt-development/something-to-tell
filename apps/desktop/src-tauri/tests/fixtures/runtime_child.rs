//! A disposable std-only process fixture, not a production HTTP/auth implementation.
use std::io::{BufRead, Read, Write};
use std::net::TcpListener;

fn main() {
    let executable = std::env::current_exe().unwrap();
    let root = executable.parent().unwrap().parent().unwrap();
    let mode = root.file_name().unwrap().to_str().unwrap();
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    if lines.next().is_none() { return; }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::fs::write(root.join("port.txt"), port.to_string()).unwrap();
    if mode == "timeout" {
        let _ = lines.next();
        return;
    }
    if mode == "invalid" {
        println!("invalid private frame");
    } else if mode == "oversized" {
        println!("{}", "x".repeat(4097));
    } else {
        let pid = std::process::id() + u32::from(mode == "wrong_pid");
        let version = if mode == "wrong_version" { "99.0.0" } else { "0.1.0" };
        println!("{{\"protocol_version\":1,\"type\":\"ready\",\"port\":{port},\"pid\":{pid},\"runtime_version\":\"{version}\"}}");
    }
    std::io::stdout().flush().unwrap();
    let mode = mode.to_string();
    std::thread::spawn(move || {
        for connection in listener.incoming() {
            let mut stream = match connection { Ok(stream) => stream, Err(_) => break };
            stream.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
            let mut request = [0u8; 4096];
            let size = stream.read(&mut request).unwrap_or(0);
            // Assert that the probe sends a bearer; Python tests cover actual token equality.
            let authenticated = String::from_utf8_lossy(&request[..size]).to_lowercase().contains("authorization: bearer ");
            let status = if mode == "redirect" { "302 Found" }
                else if mode == "bad_health" || !authenticated { "403 Forbidden" } else { "200 OK" };
            let body = if mode == "bad_json" { "not-json" }
                else { "{\"status\":\"ok\",\"service\":\"runtime\",\"version\":\"0.1.0\"}" };
            let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nLocation: http://127.0.0.1:8719/\r\nConnection: close\r\n\r\n{body}", body.len());
        }
    });
    let _ = lines.next(); // A private stop frame or EOF ends only this owned fixture.
}
