from twilio_tls_handshake_audit import code_of, listener, sweep, verdict


def alert(sid, url, code="11220"):
    return {"sid": sid, "request_url": url, "error_code": code,
            "date_generated": "2026-05-05T14:08:00Z"}


def test_listener_always_writes_the_port_out():
    assert listener("https://hooks.example.com/voice") == "hooks.example.com:443"
    assert listener("https://Hooks.Example.com:8443/voice") == "hooks.example.com:8443"
    assert listener("http://hooks.example.com/voice") == "hooks.example.com:80"
    assert listener("not a url") == ""
    assert listener(None) == ""


def test_code_of_reads_the_string_the_monitor_api_returns():
    assert code_of({"error_code": "11220"}) == 11220
    assert code_of({"error_code": 11220}) == 11220
    assert code_of({"error_code": ""}) is None
    assert code_of({}) is None


def test_sweep_drops_listeners_with_no_handshake_failure():
    rows = sweep([alert("A1", "https://a.example.com/voice"),
                  alert("A2", "https://b.example.com/voice", code="11200"),
                  alert("A3", "https://a.example.com:8443/voice")])
    assert sorted(rows) == ["a.example.com:443", "a.example.com:8443"]


def test_two_ports_on_one_host_are_two_listeners():
    rows = sweep([alert("A1", "https://a.example.com/voice"),
                  alert("A2", "https://a.example.com:8443/voice")])
    assert rows["a.example.com:443"]["codes"][11220] == 1
    assert rows["a.example.com:8443"]["codes"][11220] == 1


def test_a_certificate_code_beside_it_means_the_handshake_got_further():
    state, detail = verdict({"codes": {11220: 40, 11236: 12}})
    assert state == "certificate-first"
    assert "11236" in detail


def test_a_code_that_needed_a_response_means_one_stale_node():
    # 11200 cannot be raised without a completed handshake, so TLS worked for
    # those requests and the endpoint as a whole negotiates fine.
    state, detail = verdict({"codes": {11220: 9, 11200: 300}})
    assert state == "one-node"
    assert "balancer" in detail


def test_only_11220_is_the_plain_protocol_mismatch():
    state, detail = verdict({"codes": {11220: 512}})
    assert state == "no-shared-parameters"
    assert "cipher suite" in detail


def test_no_handshake_failures_is_clean():
    assert verdict({"codes": {11200: 4}})[0] == "clean"
    assert verdict({})[0] == "clean"
