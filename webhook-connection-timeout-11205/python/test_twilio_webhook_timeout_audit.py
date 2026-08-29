from twilio_webhook_timeout_audit import code_of, host_of, tally, unroutable, verdict


def alert(sid, url, code="11205", when="2026-04-01T12:00:00Z"):
    return {"sid": sid, "request_url": url, "error_code": code,
            "date_generated": when, "log_level": "error"}


def test_code_of_reads_the_string_the_monitor_api_returns():
    assert code_of({"error_code": "11205"}) == 11205
    assert code_of({"error_code": 11205}) == 11205
    assert code_of({"error_code": ""}) is None


def test_host_of_drops_the_path_and_the_port():
    assert host_of("https://Hooks.Example.com:8443/voice?CallSid=CA1") == \
        "hooks.example.com"
    assert host_of("https://hooks.example.com/sms") == "hooks.example.com"
    assert host_of(None) == ""


def test_the_172_block_stops_at_31():
    # RFC 1918 reserves 172.16.0.0/12. Getting this wrong sends somebody to
    # argue with a network team about a perfectly public address.
    assert unroutable("172.16.0.1") == "private address"
    assert unroutable("172.31.255.254") == "private address"
    assert unroutable("172.32.0.1") is None
    assert unroutable("172.15.0.1") is None


def test_the_other_addresses_twilio_can_never_dial():
    assert unroutable("127.0.0.1") == "loopback"
    assert unroutable("localhost") == "loopback"
    assert unroutable("10.4.2.1") == "private address"
    assert unroutable("192.168.1.10") == "private address"
    assert unroutable("169.254.169.254") == "link-local address"
    assert unroutable("100.100.0.1") == "carrier-grade NAT address"
    assert unroutable("hooks.example.com") is None
    assert unroutable("999.1.1.1") == "malformed IP literal"


def test_tally_keeps_both_codes_on_one_host():
    rows = tally([alert("NO1", "https://hooks.example.com/voice"),
                  alert("NO2", "https://hooks.example.com/sms"),
                  alert("NO3", "https://hooks.example.com/sms", code="11200"),
                  alert("NO4", "https://hooks.example.com/sms", code="11236")])
    row = rows["hooks.example.com"]
    assert row["timeouts"] == 2
    assert row["retrievals"] == 1
    assert row["sids"] == ["NO1", "NO2"]


def test_a_private_address_is_reported_on_a_single_alert():
    state, detail = verdict("10.0.0.7", {"timeouts": 1, "retrievals": 0})
    assert state == "misconfigured"
    assert "No firewall change" in detail


def test_a_host_with_both_codes_is_capacity_not_a_firewall():
    state, detail = verdict("hooks.example.com", {"timeouts": 40, "retrievals": 2})
    assert state == "flapping"
    assert "10 second" in detail


def test_a_run_of_timeouts_with_no_replies_is_unreachable():
    state, detail = verdict("hooks.example.com", {"timeouts": 40, "retrievals": 0})
    assert state == "unreachable"
    assert "access log" in detail


def test_one_timeout_is_a_restart_not_an_outage():
    state, _ = verdict("hooks.example.com", {"timeouts": 1, "retrievals": 0})
    assert state == "isolated"


def test_retrieval_failures_alone_are_not_this_report():
    state, _ = verdict("hooks.example.com", {"timeouts": 0, "retrievals": 90})
    assert state == "clean"
