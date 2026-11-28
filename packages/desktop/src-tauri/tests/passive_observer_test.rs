//! The desktop capture layer observes a program from outside and takes no
//! part in it (core capture principles, CP-20). These tests read the desktop
//! application's own Rust source and fail on a call that would break that.
//! The lists below name the calls looked for; an act they do not name is
//! judged at review.
//! They run on every platform: nothing here calls Windows.

use std::fs;
use std::path::{Path, PathBuf};

/// Calls that put code or data into another process, start a thread in one,
/// or end, suspend or attach a debugger to one, and the flag that asks Windows to run an event hook inside the
/// watched program. None may be named anywhere in the source, the generated
/// bindings and the list they are generated from included.
const INTO_ANOTHER_PROCESS: &[&str] = &[
    "CreateRemoteThread",
    "CreateRemoteThreadEx",
    "NtCreateThreadEx",
    "RtlCreateUserThread",
    "QueueUserAPC",
    "QueueUserAPC2",
    "SetThreadContext",
    "WriteProcessMemory",
    "NtWriteVirtualMemory",
    "VirtualAllocEx",
    "VirtualProtectEx",
    "NtMapViewOfSection",
    "WINEVENT_INCONTEXT",
    "PROCESS_ALL_ACCESS",
    "PROCESS_VM_WRITE",
    "PROCESS_VM_OPERATION",
    "PROCESS_CREATE_THREAD",
    "TerminateProcess",
    "DebugActiveProcess",
    "SuspendThread",
];

/// The two kinds of Windows hook that run in the process that set them.
const HOOKS_IN_OUR_OWN_PROCESS: &[&str] = &["WH_KEYBOARD_LL", "WH_MOUSE_LL"];

/// Calls that send a program input or change one of its windows. The
/// bindings hold them for the tests that drive a window of their own; the
/// application's own code names none.
const ACTS_ON_ANOTHER_PROGRAM: &[&str] = &[
    "SendInput",
    "keybd_event",
    "mouse_event",
    "SetForegroundWindow",
    "BringWindowToTop",
    "AttachThreadInput",
    "SetWindowTextW",
    "SetWindowPos",
    "SetWindowLongW",
    "SetWindowLongPtrW",
    "PostMessageW",
    "SendMessageW",
    "SendNotifyMessageW",
    "SendMessageA",
    "PostMessageA",
    "SetWindowTextA",
    "MoveWindow",
    "SetFocus",
    "SetActiveWindow",
];

/// The generated bindings: declarations, with no code of the application.
const BINDINGS: &str = "win32_bindings.rs";

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Every Rust source file under `dir`.
fn rust_files(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .map(|entry| entry.expect("a directory entry").path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            found.extend(rust_files(&path));
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            found.push(path);
        }
    }
    found
}

/// The identifiers of `text`, each with its line number, comments left out.
fn identifiers(text: &str) -> Vec<(usize, &str)> {
    text.lines()
        .enumerate()
        .filter(|(_, line)| !line.trim_start().starts_with("//"))
        .flat_map(|(number, line)| {
            line.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .filter(|token| !token.is_empty())
                .map(move |token| (number + 1, token))
        })
        .collect()
}

/// The part of a source file that is the application's own code: what
/// stands ahead of its first test module. `Err` names a line behind that
/// module that is neither inside a test module nor one's opening or end, so
/// that code moved behind the tests cannot go unread.
fn application_code(text: &str) -> Result<&str, usize> {
    let lines: Vec<&str> = text.lines().collect();
    let Some(first) = lines
        .windows(2)
        .position(|pair| pair[0] == "#[cfg(test)]" && pair[1].starts_with("mod "))
    else {
        return Ok(text);
    };
    for (index, line) in lines.iter().enumerate().skip(first) {
        let inside = line.is_empty() || line.starts_with(' ') || line.starts_with("//");
        let frame = *line == "#[cfg(test)]" || line.starts_with("mod ") || *line == "}";
        if !inside && !frame {
            return Err(index + 1);
        }
    }
    let offset: usize = lines[..first].iter().map(|line| line.len() + 1).sum();
    Ok(&text[..offset.min(text.len())])
}

/// Each use in `text` of a name from `names`, as `line: name`.
fn uses_of(text: &str, names: &[&str]) -> Vec<String> {
    identifiers(text)
        .into_iter()
        .filter(|(_, token)| names.contains(token))
        .map(|(line, token)| format!("{line}: {token}"))
        .collect()
}

/// Each Windows hook kind named in `text` other than the two that run in the
/// process that set them.
fn hooks_in_another_process(text: &str) -> Vec<String> {
    identifiers(text)
        .into_iter()
        .filter(|(_, token)| token.starts_with("WH_") && !HOOKS_IN_OUR_OWN_PROCESS.contains(token))
        .map(|(line, token)| format!("{line}: {token}"))
        .collect()
}

#[test]
fn no_source_names_a_call_into_another_process() {
    let mut files = rust_files(&manifest_dir().join("src"));
    files.push(manifest_dir().join("tools/bindgen/filter.txt"));
    let mut found = Vec::new();
    for path in files {
        let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let mut hits = uses_of(&text, INTO_ANOTHER_PROCESS);
        hits.extend(hooks_in_another_process(&text));
        found.extend(
            hits.into_iter()
                .map(|hit| format!("{}:{hit}", path.display())),
        );
    }
    assert!(
        found.is_empty(),
        "the desktop runs in its own process alone (core CP-20); found:\n{}",
        found.join("\n")
    );
}

#[test]
fn the_applications_own_code_sends_no_input_and_changes_no_window() {
    let mut found = Vec::new();
    for path in rust_files(&manifest_dir().join("src")) {
        if path.file_name().is_some_and(|name| name == BINDINGS) {
            continue;
        }
        let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        match application_code(&text) {
            Ok(code) => found.extend(
                uses_of(code, ACTS_ON_ANOTHER_PROGRAM)
                    .into_iter()
                    .map(|hit| format!("{}:{hit}", path.display())),
            ),
            Err(line) => found.push(format!(
                "{}:{line}: code behind the first test module is not read by this test",
                path.display()
            )),
        }
    }
    assert!(
        found.is_empty(),
        "the desktop observes a program and takes no part in it (core CP-20); found:\n{}",
        found.join("\n")
    );
}

/// The readers above find what they are there to find, in source written
/// for the purpose: without this, a reader that found nothing would pass
/// every tree.
#[test]
fn the_readers_find_a_breach_written_for_them() {
    let breach = "fn f() {\n    unsafe { WriteProcessMemory(h, p, b, n, None) };\n    let k = WH_GETMESSAGE;\n    // SendInput in a comment is no call\n    SendInput(&inputs, size);\n}\n#[cfg(test)]\nmod tests {\n    fn g() { SetForegroundWindow(w); }\n}\n";
    assert_eq!(
        uses_of(breach, INTO_ANOTHER_PROCESS),
        vec!["2: WriteProcessMemory"]
    );
    assert_eq!(hooks_in_another_process(breach), vec!["3: WH_GETMESSAGE"]);
    assert_eq!(
        hooks_in_another_process("SetWindowsHookExW(WH_KEYBOARD_LL, f, None, 0); WH_MOUSE_LL"),
        Vec::<String>::new()
    );
    let code = application_code(breach).expect("nothing stands behind the test module");
    assert_eq!(uses_of(code, ACTS_ON_ANOTHER_PROGRAM), vec!["5: SendInput"]);
    assert_eq!(
        application_code("#[cfg(test)]\nmod tests {\n}\nfn late() {}\n"),
        Err(4)
    );
}
