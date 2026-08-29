from twilio_landline_audit import describe, tally, verdict

DESK = "+15551230000"


def failure(sid, code, to=DESK):
    return {"sid": sid, "direction": "outbound-api", "to": to,
            "status": "undelivered", "error_code": code}


def test_the_two_codes_are_counted_separately():
    rows = tally([failure("SM1", 30006), failure("SM2", 21614),
                  failure("SM3", 30006), failure("SM4", 30007)])
    assert rows[DESK]["undelivered"] == 2
    assert rows[DESK]["rejected"] == 1
    assert rows[DESK]["attempts"] == 3   # 30007 belongs to a different report


def test_describe_says_which_half_was_billed():
    told = describe({"undelivered": 2, "rejected": 1})
    assert "billed" in told
    assert "not billed" in told


def test_lookup_landline_is_permanent():
    state, detail = verdict({"undelivered": 4}, "landline")
    assert state == "landline"
    assert "Retrying never helps" in detail


def test_fixed_voip_is_treated_like_a_landline():
    assert verdict({"undelivered": 2}, "fixedVoip")[0] == "landline"


def test_a_mobile_that_keeps_failing_is_the_senders_problem():
    state, detail = verdict({"undelivered": 6}, "mobile")
    assert state == "sender-cannot-reach"
    assert "short code" in detail


def test_no_lookup_and_one_failure_is_not_yet_a_verdict():
    state, detail = verdict({"rejected": 1})
    assert state == "one-off"
    assert "Confirm with Lookup" in detail


def test_no_lookup_and_repeated_failures_is_treated_as_permanent():
    state, detail = verdict({"undelivered": 5})
    assert state == "undeliverable"
    assert "5 refused" in detail


def test_an_unknown_line_type_does_not_pretend_to_know():
    assert verdict({"undelivered": 5}, "unknown")[0] == "undeliverable"
    assert verdict({"undelivered": 5}, "invalid")[0] == "not-sms-capable"
    assert verdict({"attempts": 3})[0] == "clean"
