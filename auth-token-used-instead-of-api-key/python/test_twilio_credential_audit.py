from twilio_credential_audit import credential_kind, verdict

KEY = {"sid": "SK00000000000000000000000000000001", "friendly_name": "billing-worker"}


def test_an_sk_username_is_an_api_key():
    assert credential_kind("SK00000000000000000000000000000001") == "api-key"


def test_an_account_sid_as_the_username_means_the_auth_token():
    assert credential_kind("AC00000000000000000000000000000001") == "auth-token"


def test_case_and_whitespace_do_not_change_the_answer():
    assert credential_kind("  sk0123456789  ") == "api-key"
    assert credential_kind("ac0123456789") == "auth-token"


def test_an_empty_or_odd_username_is_not_guessed_at():
    assert credential_kind("") == "unknown"
    assert credential_kind(None) == "unknown"
    assert credential_kind("username") == "unknown"


def test_no_keys_at_all_is_the_headline_finding():
    state, detail = verdict([], workloads=4)
    assert state == "no-keys"
    assert "signs your webhooks" in detail


def test_running_under_the_auth_token_outranks_a_healthy_key_count():
    # Six keys and a tidy account, and this shell still holds the account secret.
    state, detail = verdict([KEY] * 6, workloads=3, running_as="auth-token")
    assert state == "auth-token"
    assert "proof" in detail


def test_fewer_keys_than_workloads_means_a_shared_credential():
    state, detail = verdict([KEY, KEY], workloads=7, running_as="api-key")
    assert state == "under-keyed"
    assert "share a credential" in detail


def test_a_key_per_workload_passes():
    state, _ = verdict([KEY] * 5, workloads=5, running_as="api-key")
    assert state == "keyed"


def test_an_unknown_workload_count_does_not_manufacture_a_finding():
    state, _ = verdict([KEY], workloads=0, running_as="api-key")
    assert state == "keyed"
