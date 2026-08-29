from twilio_webhook_url_audit import (
    NUMBER_URL_FIELDS, audit, classify_url, is_private_host, worst)


def test_https_on_a_public_host_is_ok():
    state, detail = classify_url("https://hooks.example.com/voice")
    assert state == "ok"
    assert "public hostname" in detail


def test_http_is_reported_as_a_cleartext_signature():
    state, detail = classify_url("http://hooks.example.com/voice")
    assert state == "cleartext"
    assert "X-Twilio-Signature" in detail


def test_private_and_loopback_hosts_are_unreachable():
    for url in ("https://localhost:3000/voice", "https://127.0.0.1/voice",
                "https://10.0.4.31/sms", "https://192.168.1.20/sms",
                "https://172.16.0.9/sms", "https://169.254.169.254/voice"):
        assert classify_url(url)[0] == "unreachable", url


def test_the_172_boundary_is_where_the_rfc_puts_it():
    # 172.31 is private and 172.32 is not. A check that slides this edge either
    # clears a number that has never worked or condemns one that does.
    assert is_private_host("172.31.255.255") is True
    assert is_private_host("172.32.0.1") is False
    assert is_private_host("172.15.0.1") is False


def test_tunnel_hosts_are_their_own_finding():
    for url in ("https://ab12cd.ngrok.io/voice",
                "https://tall-cat-runs.trycloudflare.com/sms",
                "https://demo.loca.lt/voice"):
        state, detail = classify_url(url)
        assert state == "tunnel", url
        assert "laptop sleeps" in detail


def test_an_unreachable_host_over_http_leads_with_the_outage():
    # Both faults are present. Only one of them is costing anything today.
    assert classify_url("http://localhost:3000/voice")[0] == "unreachable"


def test_a_blank_field_is_unset_and_a_relative_path_is_unreadable():
    assert classify_url("")[0] == "unset"
    assert classify_url(None)[0] == "unset"
    assert classify_url("/voice")[0] == "unreadable"
    assert classify_url("ftp://hooks.example.com/voice")[0] == "unreadable"


def test_worst_ranks_the_outage_above_the_exposure():
    number = {"voice_url": "http://hooks.example.com/voice",
              "sms_url": "https://10.0.4.31/sms",
              "voice_fallback_url": "https://hooks.example.com/fallback"}
    findings = audit(number, NUMBER_URL_FIELDS)
    assert worst(findings) == "unreachable"
    assert ("voice_url", "cleartext") == findings[0][:2]


def test_a_fully_healthy_number_reports_ok():
    number = {"voice_url": "https://hooks.example.com/voice",
              "sms_url": "https://hooks.example.com/sms"}
    assert worst(audit(number, NUMBER_URL_FIELDS)) == "unset"
