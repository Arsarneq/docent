// Secret-at-rest storage (S2).
//
// The dispatch and sync API keys were previously written verbatim into
// `%APPDATA%/com.docent.desktop/session.json`. Anyone (or anything) with read
// access to that file — backup tooling, sync clients, another local user,
// forensic recovery — could lift the keys straight off disk.
//
// This module moves those two keys out of the JSON blob and into the OS
// credential store (Windows Credential Manager via the `keyring` crate). The
// session file keeps everything else; the secret fields are stripped before
// the file is written and re-injected when it is read, so the rest of the app
// (frontend + `panel.js`) is unchanged.
//
// Design notes:
// - The persistence chokepoint is `load_state` / `save_state` in `commands.rs`.
//   Intercepting there means no JavaScript call site has to change and there is
//   exactly one place that can leak a key to disk.
// - The store is expressed as a `SecretStore` trait so the strip/inject logic
//   can be unit-tested with an in-memory mock — no real credential store is
//   touched in CI, which keeps the tests deterministic (no flakiness, no
//   machine state).
// - On non-Windows targets (which have no capture backend and are not shipped —
//   see `capture::stub`) the store is a no-op `DisabledStore`, and the keys are
//   left inline in the JSON exactly as before. This keeps the cross-platform
//   `cargo check` green without pulling a credential backend onto those targets.

use serde_json::Value;

/// Logical names of the secret fields under `settings` in the session JSON.
/// These double as the credential-store entry names.
pub const API_KEY_FIELD: &str = "apiKey";
pub const SYNC_API_KEY_FIELD: &str = "syncApiKey";

/// All secret fields managed by this module, in a stable order.
pub const SECRET_FIELDS: [&str; 2] = [API_KEY_FIELD, SYNC_API_KEY_FIELD];

/// Abstraction over a per-key secret store so the strip/inject logic is
/// testable without touching a real OS credential store.
pub trait SecretStore {
    /// Whether secret-at-rest storage is active. When `false`, callers skip
    /// the strip/inject entirely and leave the keys inline in the JSON (the
    /// pre-S2 behaviour). Defaults to `true`; [`DisabledStore`] overrides it.
    fn enabled(&self) -> bool {
        true
    }

    /// Persist `value` under `name`. Overwrites any existing value.
    fn set(&self, name: &str, value: &str) -> Result<(), String>;

    /// Fetch the value stored under `name`, or `None` if there is none.
    fn get(&self, name: &str) -> Result<Option<String>, String>;

    /// Remove the value stored under `name`. Removing a missing entry is Ok.
    fn delete(&self, name: &str) -> Result<(), String>;
}

/// Strip the managed secret fields out of `settings`, persisting each one to
/// `store`. A field that is present and a non-empty string is written to the
/// store and removed from the JSON; a field that is absent, null, or an empty
/// string is deleted from the store (so clearing a key in the UI also clears
/// the credential) and removed from the JSON.
///
/// `state` is the full parsed session object; this mutates `state.settings`
/// in place. Missing `settings` is a no-op.
pub fn strip_secrets(state: &mut Value, store: &dyn SecretStore) -> Result<(), String> {
    let Some(settings) = state.get_mut("settings").and_then(Value::as_object_mut) else {
        return Ok(());
    };

    for field in SECRET_FIELDS {
        match settings.remove(field) {
            Some(Value::String(s)) if !s.is_empty() => {
                store.set(field, &s)?;
            }
            // Present-but-empty, null, or any non-string: treat as "no secret".
            // Removing the entry keeps the store in sync with a cleared field.
            Some(_) => {
                store.delete(field)?;
            }
            // Field absent entirely: leave the store untouched. (A load /
            // modify-unrelated / save cycle must not wipe a configured key
            // just because this particular save didn't carry it.)
            None => {}
        }
    }

    Ok(())
}

/// Re-inject the managed secret fields into `settings` from `store`. Called on
/// read so the frontend sees the same shape it always has. A field already
/// present in the JSON is left as-is (the file is authoritative for that load);
/// otherwise the value from the store, if any, is inserted.
///
/// If the store holds none of the secrets, the JSON is left untouched — in
/// particular an object without `settings` stays without `settings` (so e.g.
/// the empty `"{}"` state round-trips unchanged).
pub fn inject_secrets(state: &mut Value, store: &dyn SecretStore) -> Result<(), String> {
    // Gather whatever the store holds for the managed fields first, so we only
    // touch `state` when there is actually something to inject.
    let mut found: Vec<(&str, String)> = Vec::new();
    for field in SECRET_FIELDS {
        if let Some(value) = store.get(field)? {
            found.push((field, value));
        }
    }
    if found.is_empty() {
        return Ok(());
    }

    // Ensure there is a settings object to inject into (creating it only now
    // that we know there is a secret to place).
    if !state.get("settings").map(Value::is_object).unwrap_or(false) {
        if let Value::Object(map) = state {
            map.insert("settings".to_string(), Value::Object(Default::default()));
        } else {
            // Not a JSON object at all — nowhere to inject.
            return Ok(());
        }
    }

    let settings = state
        .get_mut("settings")
        .and_then(Value::as_object_mut)
        .expect("settings ensured above");

    for (field, value) in found {
        // A field already present in the file is authoritative for this load.
        settings
            .entry(field.to_string())
            .or_insert(Value::String(value));
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Windows: real credential-store backend
// ---------------------------------------------------------------------------

/// Service name under which Docent's secrets are filed in the OS store.
#[cfg(windows)]
const SERVICE: &str = "com.docent.desktop";

/// Credential-store backed [`SecretStore`] (Windows Credential Manager).
#[cfg(windows)]
pub struct KeyringStore;

#[cfg(windows)]
impl SecretStore for KeyringStore {
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, name)
            .map_err(|e| format!("Failed to open credential entry '{name}': {e}"))?;
        entry
            .set_password(value)
            .map_err(|e| format!("Failed to store credential '{name}': {e}"))
    }

    fn get(&self, name: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(SERVICE, name)
            .map_err(|e| format!("Failed to open credential entry '{name}': {e}"))?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Failed to read credential '{name}': {e}")),
        }
    }

    fn delete(&self, name: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, name)
            .map_err(|e| format!("Failed to open credential entry '{name}': {e}"))?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Failed to delete credential '{name}': {e}")),
        }
    }
}

/// Return the platform credential store (Windows Credential Manager).
#[cfg(windows)]
pub fn default_store() -> Box<dyn SecretStore> {
    Box::new(KeyringStore)
}

// ---------------------------------------------------------------------------
// Disabled backend (keys stay inline, as before)
// ---------------------------------------------------------------------------

/// No-op [`SecretStore`] that reports `enabled() == false`, so callers skip the
/// strip/inject and leave the keys inline in the JSON. Used as the default
/// store on targets without a credential backend, and by tests that exercise
/// the raw filesystem persistence (so they don't touch the machine-global
/// credential store).
pub struct DisabledStore;

impl SecretStore for DisabledStore {
    fn enabled(&self) -> bool {
        false
    }

    fn set(&self, _name: &str, _value: &str) -> Result<(), String> {
        Ok(())
    }

    fn get(&self, _name: &str) -> Result<Option<String>, String> {
        Ok(None)
    }

    fn delete(&self, _name: &str) -> Result<(), String> {
        Ok(())
    }
}

/// Return the (disabled) secret store on targets without a credential backend.
/// The keys stay inline in the JSON, matching the pre-S2 behaviour.
#[cfg(not(windows))]
pub fn default_store() -> Box<dyn SecretStore> {
    Box::new(DisabledStore)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// In-memory `SecretStore` for deterministic tests — no OS keychain.
    #[derive(Default)]
    struct MemStore {
        map: Mutex<HashMap<String, String>>,
        fail: bool,
    }

    impl MemStore {
        fn new() -> Self {
            Self::default()
        }

        fn failing() -> Self {
            MemStore {
                map: Mutex::new(HashMap::new()),
                fail: true,
            }
        }

        fn contains(&self, name: &str) -> bool {
            self.map.lock().unwrap().contains_key(name)
        }
    }

    impl SecretStore for MemStore {
        fn set(&self, name: &str, value: &str) -> Result<(), String> {
            if self.fail {
                return Err("mock set failure".into());
            }
            self.map
                .lock()
                .unwrap()
                .insert(name.to_string(), value.to_string());
            Ok(())
        }

        fn get(&self, name: &str) -> Result<Option<String>, String> {
            if self.fail {
                return Err("mock get failure".into());
            }
            Ok(self.map.lock().unwrap().get(name).cloned())
        }

        fn delete(&self, name: &str) -> Result<(), String> {
            if self.fail {
                return Err("mock delete failure".into());
            }
            self.map.lock().unwrap().remove(name);
            Ok(())
        }
    }

    fn json(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    // ── strip_secrets ────────────────────────────────────────────────────────

    #[test]
    fn strip_moves_keys_to_store_and_removes_from_json() {
        let store = MemStore::new();
        let mut state = json(
            r#"{"settings":{"endpointUrl":"https://api.test","apiKey":"k1","syncUrl":"https://s.test","syncApiKey":"k2"}}"#,
        );

        strip_secrets(&mut state, &store).unwrap();

        let settings = state["settings"].as_object().unwrap();
        assert!(
            !settings.contains_key("apiKey"),
            "apiKey should be stripped"
        );
        assert!(
            !settings.contains_key("syncApiKey"),
            "syncApiKey should be stripped"
        );
        // Non-secret fields stay.
        assert_eq!(settings["endpointUrl"], "https://api.test");
        assert_eq!(settings["syncUrl"], "https://s.test");
        // Secrets landed in the store.
        assert_eq!(store.get("apiKey").unwrap().as_deref(), Some("k1"));
        assert_eq!(store.get("syncApiKey").unwrap().as_deref(), Some("k2"));
    }

    #[test]
    fn strip_deletes_store_entry_for_empty_string() {
        let store = MemStore::new();
        store.set("apiKey", "stale").unwrap();
        let mut state = json(r#"{"settings":{"apiKey":""}}"#);

        strip_secrets(&mut state, &store).unwrap();

        assert!(!state["settings"]
            .as_object()
            .unwrap()
            .contains_key("apiKey"));
        assert!(
            !store.contains("apiKey"),
            "empty string should clear the credential"
        );
    }

    #[test]
    fn strip_deletes_store_entry_for_null() {
        let store = MemStore::new();
        store.set("syncApiKey", "stale").unwrap();
        let mut state = json(r#"{"settings":{"syncApiKey":null}}"#);

        strip_secrets(&mut state, &store).unwrap();

        assert!(!store.contains("syncApiKey"));
    }

    #[test]
    fn strip_leaves_store_untouched_when_field_absent() {
        let store = MemStore::new();
        store.set("apiKey", "keep-me").unwrap();
        // settings present but carries no apiKey field at all.
        let mut state = json(r#"{"settings":{"endpointUrl":"https://api.test"}}"#);

        strip_secrets(&mut state, &store).unwrap();

        assert_eq!(
            store.get("apiKey").unwrap().as_deref(),
            Some("keep-me"),
            "absent field must not wipe a configured credential"
        );
    }

    #[test]
    fn strip_noop_without_settings() {
        let store = MemStore::new();
        let mut state = json(r#"{"projects":[]}"#);
        strip_secrets(&mut state, &store).unwrap();
        assert_eq!(state, json(r#"{"projects":[]}"#));
    }

    #[test]
    fn strip_propagates_store_error() {
        let store = MemStore::failing();
        let mut state = json(r#"{"settings":{"apiKey":"k1"}}"#);
        let err = strip_secrets(&mut state, &store).unwrap_err();
        assert!(err.contains("mock set failure"));
    }

    // ── inject_secrets ─────────────────────────────────────────────────────────

    #[test]
    fn inject_restores_keys_from_store() {
        let store = MemStore::new();
        store.set("apiKey", "k1").unwrap();
        store.set("syncApiKey", "k2").unwrap();
        let mut state = json(r#"{"settings":{"endpointUrl":"https://api.test"}}"#);

        inject_secrets(&mut state, &store).unwrap();

        let settings = state["settings"].as_object().unwrap();
        assert_eq!(settings["apiKey"], "k1");
        assert_eq!(settings["syncApiKey"], "k2");
        assert_eq!(settings["endpointUrl"], "https://api.test");
    }

    #[test]
    fn inject_does_not_overwrite_existing_field() {
        let store = MemStore::new();
        store.set("apiKey", "from-store").unwrap();
        let mut state = json(r#"{"settings":{"apiKey":"from-file"}}"#);

        inject_secrets(&mut state, &store).unwrap();

        assert_eq!(state["settings"]["apiKey"], "from-file");
    }

    #[test]
    fn inject_creates_settings_when_store_has_secrets() {
        let store = MemStore::new();
        store.set("apiKey", "k1").unwrap();
        let mut state = json(r#"{"projects":[]}"#);

        inject_secrets(&mut state, &store).unwrap();

        assert_eq!(state["settings"]["apiKey"], "k1");
    }

    #[test]
    fn inject_does_not_create_settings_when_store_empty() {
        // Regression: an object without `settings` must stay without it when
        // the store holds no secrets (so `"{}"` round-trips unchanged).
        let store = MemStore::new();
        let mut state = json(r#"{"projects":[]}"#);

        inject_secrets(&mut state, &store).unwrap();

        assert_eq!(state, json(r#"{"projects":[]}"#));
        assert!(state.get("settings").is_none());
    }

    #[test]
    fn inject_leaves_bare_empty_object_untouched() {
        let store = MemStore::new();
        let mut state = json("{}");
        inject_secrets(&mut state, &store).unwrap();
        assert_eq!(state, json("{}"));
    }

    #[test]
    fn disabled_store_reports_not_enabled() {
        assert!(!DisabledStore.enabled());
        assert!(MemStore::new().enabled(), "default trait impl is enabled");
    }

    #[test]
    fn inject_is_noop_when_store_empty() {
        let store = MemStore::new();
        let mut state = json(r#"{"settings":{"endpointUrl":"https://api.test"}}"#);

        inject_secrets(&mut state, &store).unwrap();

        let settings = state["settings"].as_object().unwrap();
        assert!(!settings.contains_key("apiKey"));
        assert!(!settings.contains_key("syncApiKey"));
    }

    #[test]
    fn inject_propagates_store_error() {
        let store = MemStore::failing();
        let mut state = json(r#"{"settings":{}}"#);
        let err = inject_secrets(&mut state, &store).unwrap_err();
        assert!(err.contains("mock get failure"));
    }

    // ── round-trip ─────────────────────────────────────────────────────────────

    #[test]
    fn strip_then_inject_round_trips() {
        let store = MemStore::new();
        let original = json(
            r#"{"projects":[{"project_id":"p"}],"settings":{"endpointUrl":"https://api.test","apiKey":"k1","syncApiKey":"k2","theme":"dark"}}"#,
        );

        let mut on_disk = original.clone();
        strip_secrets(&mut on_disk, &store).unwrap();
        // The file written to disk must not contain either secret.
        let disk_text = serde_json::to_string(&on_disk).unwrap();
        assert!(!disk_text.contains("k1"));
        assert!(!disk_text.contains("k2"));

        // On read, the secrets are restored and we get the original back.
        let mut loaded = on_disk;
        inject_secrets(&mut loaded, &store).unwrap();
        assert_eq!(loaded, original);
    }
}
