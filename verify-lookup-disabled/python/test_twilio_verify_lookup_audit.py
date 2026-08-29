from twilio_verify_lookup_audit import attempts_for, verdict


def test_both_settings_on_is_the_only_guarded_state():
    state, detail = verdict({"lookup_enabled": True, "skip_sms_to_landlines": True})
    assert state == "guarded"
    assert "line type is checked" in detail


def test_skip_without_lookup_is_a_guard_that_never_runs():
    # The reason this note exists: the visible setting is on and inert.
    state, detail = verdict({"lookup_enabled": False, "skip_sms_to_landlines": True})
    assert state == "no-op-guard"
    assert "never runs" in detail


def test_lookup_without_skip_still_sends_to_landlines():
    state, detail = verdict({"lookup_enabled": True, "skip_sms_to_landlines": False})
    assert state == "lookup-only"
    assert "pay for a Lookup" in detail


def test_both_off_with_traffic_is_the_billing_finding():
    state, detail = verdict({"lookup_enabled": False}, 412)
    assert state == "unguarded"
    assert "412 attempt(s)" in detail
    assert "60205" in detail


def test_both_off_with_no_traffic_is_separated_from_the_live_one():
    state, detail = verdict({"lookup_enabled": False, "skip_sms_to_landlines": False}, 0)
    assert state == "unguarded-idle"
    assert "before the service is used" in detail


def test_missing_fields_are_read_as_the_defaults_they_are():
    # A service resource with neither field set is a new service: both are off.
    assert verdict({})[0] == "unguarded-idle"


def test_attempts_are_counted_per_service_from_an_account_wide_list():
    attempts = [{"service_sid": "VA1"}, {"service_sid": "VA2"}, {"service_sid": "VA1"}]
    assert attempts_for(attempts, "VA1") == 2
    assert attempts_for(attempts, "VA3") == 0
