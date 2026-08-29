from twilio_webhook_cert_audit import (at, cert_host, exposure, sweep, verdict)

START = "2026-05-01T00:00:00Z"
END = "2026-05-08T00:00:00Z"


def alert(sid, url, code="11236", when="2026-05-05T14:08:00Z"):
    return {"sid": sid, "request_url": url, "error_code": code,
            "date_generated": when, "log_level": "error"}


def test_cert_host_keeps_a_non_default_port():
    assert cert_host("https://hooks.example.com/voice") == "hooks.example.com"
    assert cert_host("https://hooks.example.com:443/voice") == "hooks.example.com"
    assert cert_host("https://Hooks.Example.com:8443/voice") == \
        "hooks.example.com:8443"
    assert cert_host("http://hooks.example.com:80/voice") == "hooks.example.com"
    assert cert_host(None) == ""


def test_at_reads_the_monitor_timestamp_as_utc():
    assert at("2026-05-05T14:08:00Z") == at("2026-05-05T14:08:00")
    assert at("2026-05-05T14:08:00Z") + 60 == at("2026-05-05T14:09:00Z")
    assert at("not a date") is None
    assert at(None) is None


def test_sweep_keeps_only_certificate_failures():
    rows = sweep([alert("NO1", "https://a.example.com/voice"),
                  alert("NO2", "https://a.example.com/sms", code="11220"),
                  alert("NO3", "https://a.example.com:8443/sms")])
    assert sorted(rows) == ["a.example.com", "a.example.com:8443"]
    assert rows["a.example.com"]["alerts"] == 1


def test_an_oldest_alert_on_the_window_edge_is_not_an_expiry_time():
    # Alerts stop at 30 days. A certificate that expired six weeks ago produces
    # an oldest alert at the edge of retention, which is a fact about Twilio's
    # storage rather than about the certificate.
    row = {"alerts": 5000, "first": "2026-05-01T00:10:00Z",
           "last": "2026-05-07T23:00:00Z"}
    state, detail = verdict(row, START, END)
    assert state == "at-retention-edge"
    assert "retention boundary" in detail


def test_a_clean_cliff_inside_the_window_is_an_expiry():
    row = {"alerts": 4000, "first": "2026-05-05T14:08:00Z",
           "last": "2026-05-07T23:30:00Z"}
    state, detail = verdict(row, START, END)
    assert state == "expired"
    assert "2026-05-05T14:08:00Z" in detail


def test_a_dozen_failures_over_five_days_is_one_stale_node():
    row = {"alerts": 12, "first": "2026-05-02T00:00:00Z",
           "last": "2026-05-07T23:30:00Z"}
    state, detail = verdict(row, START, END)
    assert state == "sporadic"
    assert "balancer" in detail


def test_silence_since_the_renewal_is_reported_as_recovered():
    row = {"alerts": 900, "first": "2026-05-02T00:00:00Z",
           "last": "2026-05-02T06:00:00Z"}
    state, detail = verdict(row, START, END)
    assert state == "recovered"
    assert "6.0 hour(s)" in detail


def test_no_alerts_is_clean():
    assert verdict({"alerts": 0}, START, END)[0] == "clean"


def test_exposure_flags_a_fallback_on_the_same_certificate():
    numbers = [
        {"phone_number": "+15550001111",
         "voice_url": "https://hooks.example.com/voice",
         "voice_fallback_url": "https://hooks.example.com/fallback",
         "sms_url": "https://other.example.net/sms"},
        {"phone_number": "+15550002222",
         "voice_url": "https://hooks.example.com/voice",
         "voice_fallback_url": "https://backup.example.net/fallback"},
        {"phone_number": "+15550003333",
         "voice_url": "https://elsewhere.example.net/voice"},
    ]
    hit = exposure(numbers, "hooks.example.com")
    assert [h["number"] for h in hit] == ["+15550001111", "+15550002222"]
    assert hit[0]["fields"] == ["voice_url", "voice_fallback_url"]
    assert hit[0]["fallback_shares_host"] is True
    assert hit[1]["fallback_shares_host"] is False
