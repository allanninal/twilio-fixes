from twilio_geo_permission_audit import dial_code, error_code, tally, verdict


def make(to, code=None, direction="outbound-api", sid="SM1", status="sent"):
    return {"to": to, "error_code": code, "direction": direction, "sid": sid,
            "status": status}


def test_country_with_only_21408_reads_as_disabled():
    stats = tally([make("+4915112345678", 21408), make("+4915112345679", 21408)])["49"]
    state, detail = verdict(stats)
    assert state == "disabled"
    assert "never enabled" in detail


def test_21408_alongside_accepted_traffic_is_a_bad_to_value():
    # The permission is on, so these failures are destinations resolving
    # somewhere other than where the code assumed.
    stats = tally([make("+12025550123"), make("+18765550123", 21408)])["1"]
    state, detail = verdict(stats)
    assert state == "partly-blocked"
    assert "enabled" in detail


def test_destination_that_is_not_e164_gets_its_own_bucket():
    stats = tally([make("07700900123", 21408)])[None]
    state, detail = verdict(stats)
    assert state == "unresolved-to"
    assert "before the setting" in detail


def test_embargoed_country_has_no_repair():
    stats = tally([make("+989121234567", 21408)])["98"]
    state, detail = verdict(stats)
    assert state == "embargoed"
    assert "stop sending" in detail


def test_country_with_no_21408_is_permitted():
    state, _ = verdict(tally([make("+33612345678"), make("+33612345679")])["33"])
    assert state == "permitted"


def test_dial_code_prefers_the_longest_match():
    assert dial_code("+998901234567") == "998"
    assert dial_code("+441632960000") == "44"
    assert dial_code("+12025550123") == "1"
    assert dial_code("447700900123") is None


def test_error_code_handles_a_string_from_an_export():
    assert error_code({"error_code": "21408"}) == 21408
    assert error_code({"error_code": None}) is None


def test_inbound_messages_are_not_counted():
    assert tally([make("+4915112345678", direction="inbound")]) == {}
