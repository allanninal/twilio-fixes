from twilio_webhook_dns_audit import (code_of, hostname, name_class,
                                       scan_numbers, tally, verdict)


def alert(sid, url, code="11210", when="2026-06-02T08:00:00Z"):
    return {"sid": sid, "request_url": url, "error_code": code,
            "date_generated": when, "log_level": "error"}


def test_code_of_reads_the_string_the_monitor_api_returns():
    assert code_of({"error_code": "11210"}) == 11210
    assert code_of({"error_code": 11210}) == 11210
    assert code_of({}) is None


def test_hostname_drops_the_port_the_path_and_a_trailing_dot():
    assert hostname("https://Hooks.Example.com:8443/voice?CallSid=CA1") == \
        "hooks.example.com"
    assert hostname("https://hooks.example.com./voice") == "hooks.example.com"
    assert hostname(None) == ""


def test_only_the_last_label_decides_a_reserved_suffix():
    # hooks.example.com is a perfectly ordinary public name; hooks.example is a
    # reserved suffix that cannot resolve. A substring match gets both wrong.
    assert name_class("hooks.example.com") == "public"
    assert name_class("hooks.example") == "reserved-suffix"
    assert name_class("api.internal") == "reserved-suffix"
    assert name_class("printer.local") == "reserved-suffix"
    assert name_class("localhost") == "reserved-suffix"


def test_the_other_shapes_a_name_can_take():
    assert name_class("webhooks") == "single-label"
    assert name_class("10.0.0.5") == "ip-literal"
    assert name_class("a1b2c3d4.ngrok.io") == "ephemeral-tunnel"
    assert name_class("wandering-cat.trycloudflare.com") == "ephemeral-tunnel"
    assert name_class("") == "empty"


def test_tally_groups_by_name_and_ignores_other_codes():
    rows = tally([alert("NO1", "https://api.internal/voice"),
                  alert("NO2", "https://api.internal/sms"),
                  alert("NO3", "https://api.internal/sms", code="11205")])
    assert list(rows) == ["api.internal"]
    assert rows["api.internal"]["alerts"] == 2
    assert rows["api.internal"]["sids"] == ["NO1", "NO2"]


def test_a_dead_tunnel_is_reported_as_a_development_leftover():
    state, detail = verdict("a1b2c3d4.ngrok.io", {"alerts": 60})
    assert state == "dev-tunnel"
    assert "per session" in detail


def test_an_internal_name_is_reported_as_never_having_worked():
    state, detail = verdict("api.internal", {"alerts": 9})
    assert state == "private-name"
    assert "outside" in detail


def test_a_public_looking_name_is_the_one_worth_investigating():
    state, detail = verdict("hooks.example.com", {"alerts": 9})
    assert state == "unpublished"
    assert "registration lapsed" in detail


def test_the_config_scan_finds_numbers_that_have_produced_no_alerts():
    findings = scan_numbers([
        {"phone_number": "+15550001111",
         "voice_url": "https://a1b2c3d4.ngrok.io/voice",
         "voice_fallback_url": "https://a1b2c3d4.ngrok.io/fallback",
         "sms_url": "https://hooks.example.com/sms"},
        {"phone_number": "+15550002222",
         "voice_url": "https://hooks.example.com/voice"},
    ])
    assert [(f["number"], f["field"]) for f in findings] == [
        ("+15550001111", "voice_url"), ("+15550001111", "voice_fallback_url")]
    assert all(f["class"] == "ephemeral-tunnel" for f in findings)
