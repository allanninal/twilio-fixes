from twilio_trunk_origination_audit import sip_host, transport_of, verdict


def test_sip_host_ignores_scheme_port_and_parameters():
    assert sip_host("sip:PBX.example.com:5060;transport=udp") == "pbx.example.com"
    assert sip_host("sips:pbx.example.com") == "pbx.example.com"
    assert sip_host("sip:trunk@pbx.example.com") == "pbx.example.com"
    # A bare host is not a SIP URI, so it reduces to nothing and gets reported.
    assert sip_host("pbx.example.com") == ""
    assert sip_host("") == ""


def test_transport_is_read_from_the_parameter_or_the_scheme():
    assert transport_of("sip:pbx.example.com;transport=TLS") == "tls"
    assert transport_of("sips:pbx.example.com") == "tls"
    assert transport_of("sip:pbx.example.com;transport=tcp") == "tcp"
    assert transport_of("sip:pbx.example.com") == ""


def test_no_enabled_uri_is_the_first_thing_reported():
    state, detail = verdict({}, [{"sip_url": "sip:a.example.com", "enabled": False}], 9)
    assert state == "no-enabled-uri"
    assert "9 alert(s)" in detail


def test_three_uris_on_one_host_is_not_redundancy():
    # The finding the console view argues against: three rows, one machine.
    origination = [
        {"sip_url": "sip:pbx.example.com:5060", "enabled": True, "priority": 10},
        {"sip_url": "sip:pbx.example.com:5061", "enabled": True, "priority": 20},
        {"sip_url": "sip:PBX.example.com;transport=tcp", "enabled": True, "priority": 30},
    ]
    state, detail = verdict({}, origination, 4)
    assert state == "one-host"
    assert "pbx.example.com" in detail


def test_secure_trunk_with_no_tls_uri_fails_every_call():
    origination = [{"sip_url": "sip:a.example.com;transport=udp", "enabled": True,
                    "priority": 10},
                   {"sip_url": "sip:b.example.com;transport=udp", "enabled": True,
                    "priority": 20}]
    state, detail = verdict({"secure": True}, origination, 0)
    assert state == "transport-mismatch"
    assert "every call" in detail


def test_a_secure_trunk_with_one_tls_uri_is_not_a_mismatch():
    origination = [{"sip_url": "sips:a.example.com", "enabled": True, "priority": 10},
                   {"sip_url": "sip:b.example.com", "enabled": True, "priority": 20}]
    assert verdict({"secure": True}, origination, 0)[0] == "redundant"


def test_one_enabled_uri_carries_the_alert_count():
    origination = [{"sip_url": "sip:a.example.com", "enabled": True, "priority": 10},
                   {"sip_url": "sip:b.example.com", "enabled": False, "priority": 20}]
    state, detail = verdict({}, origination, 12)
    assert state == "single-path"
    assert "12 alert(s)" in detail


def test_equal_priorities_are_load_balancing_not_failover():
    origination = [{"sip_url": "sip:a.example.com", "enabled": True, "priority": 10},
                   {"sip_url": "sip:b.example.com", "enabled": True, "priority": 10}]
    state, detail = verdict({}, origination, 0)
    assert state == "flat-priority"
    assert "not failover" in detail


def test_a_good_topology_with_alerts_points_at_the_edge():
    origination = [{"sip_url": "sip:a.example.com", "enabled": True, "priority": 10},
                   {"sip_url": "sip:b.example.com", "enabled": True, "priority": 20}]
    state, detail = verdict({}, origination, 31)
    assert state == "reachability"
    assert "TLS version" in detail


def test_a_malformed_uri_is_reported_rather_than_silently_dropped():
    origination = [{"sip_url": "pbx.example.com", "enabled": True, "priority": 10},
                   {"sip_url": "sip:b.example.com", "enabled": True, "priority": 20}]
    assert verdict({}, origination, 0)[0] == "unparseable-uri"
