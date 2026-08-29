from twilio_webhook_chain_audit import (
    apps_on_host, is_ip_literal, sweep, verdict, webhook_host)


def alert(sid, url, code="11237"):
    return {"sid": sid, "request_url": url, "error_code": code,
            "date_generated": "2026-05-05T14:08:00Z"}


def test_webhook_host_drops_the_port_because_certificates_name_hosts():
    assert webhook_host("https://Hooks.Example.com:8443/voice") == "hooks.example.com"
    assert webhook_host("https://hooks.example.com/voice") == "hooks.example.com"
    assert webhook_host("nonsense") == ""
    assert webhook_host(None) == ""


def test_is_ip_literal_accepts_addresses_and_rejects_names():
    assert is_ip_literal("203.0.113.9") is True
    assert is_ip_literal("2001:db8::1") is True
    assert is_ip_literal("hooks.example.com") is False
    assert is_ip_literal("203.0.113.999") is False
    assert is_ip_literal("") is False


def test_sweep_keeps_only_hosts_with_a_certificate_path_failure():
    rows = sweep([alert("A1", "https://a.example.com/voice"),
                  alert("A2", "https://b.example.com/voice", code="11200"),
                  alert("A3", "https://c.example.com/sms", code="11235")])
    assert sorted(rows) == ["a.example.com", "c.example.com"]


def test_a_port_does_not_split_a_host_the_way_it_splits_a_listener():
    rows = sweep([alert("A1", "https://a.example.com/voice"),
                  alert("A2", "https://a.example.com:8443/voice")])
    assert sorted(rows) == ["a.example.com"]
    assert rows["a.example.com"]["codes"][11237] == 2


def test_an_expiry_on_the_same_host_is_reported_as_one_bad_renewal():
    state, detail = verdict({"codes": {11237: 900, 11236: 120}})
    assert state == "renew-first"
    assert "one bad renewal" in detail


def test_a_mismatch_against_an_address_needs_a_name_not_a_reissue():
    state, detail = verdict({"codes": {11235: 40}, "ip": True})
    assert state == "address-not-a-name"
    assert "DNS name" in detail


def test_answered_requests_beside_11237_mean_a_partial_chain():
    state, detail = verdict({"codes": {11237: 30, 11200: 200}})
    assert state == "partial-chain"
    assert "only the leaf" in detail


def test_11237_alone_is_a_missing_intermediate_or_a_private_ca():
    state, detail = verdict({"codes": {11237: 2000}})
    assert state == "no-trust-path"
    assert "private CA" in detail


def test_both_codes_without_an_expiry_are_two_faults():
    assert verdict({"codes": {11237: 5, 11235: 5}})[0] == "chain-and-name"


def test_no_path_codes_is_clean():
    assert verdict({"codes": {11200: 12}})[0] == "clean"


def test_apps_on_host_finds_urls_that_no_phone_number_shows():
    apps = [
        {"sid": "AP1", "friendly_name": "voice router",
         "voice_url": "https://hooks.example.com/voice",
         "sms_url": "https://other.example.net/sms"},
        {"sid": "AP2", "voice_url": "https://elsewhere.example.net/voice"},
    ]
    hit = apps_on_host(apps, "hooks.example.com")
    assert [h["sid"] for h in hit] == ["AP1"]
    assert hit[0]["fields"] == ["voice_url"]
