from twilio_alpha_sender_audit import dial_code, sender_kind, tally, verdict


def make(sender, to, code=None, direction="outbound-api", sid="SM1"):
    return {"from": sender, "to": to, "error_code": code, "direction": direction,
            "sid": sid}


def test_sender_blocked_in_one_country_is_unregistered_there():
    rows = tally([make("MyBrand", "+919812345678", 30041),
                  make("MyBrand", "+919812345679", 30040)])
    state, detail = verdict(rows[("MyBrand", "91")], {"MyBrand"})
    assert state == "unregistered"
    assert "India" in detail


def test_the_same_sender_is_healthy_in_the_next_country():
    # Grouping by sender alone would average this into the Indian failures and
    # report one mostly working sender.
    rows = tally([make("MyBrand", "+919812345678", 30041),
                  make("MyBrand", "+33612345678")])
    assert verdict(rows[("MyBrand", "33")], {"MyBrand"})[0] == "delivering"


def test_case_difference_is_reported_as_a_code_change_not_a_registration():
    rows = tally([make("MYBRAND", "+919812345678", 30041)])
    state, detail = verdict(rows[("MYBRAND", "91")], {"MyBrand"})
    assert state == "case-mismatch"
    assert "byte for byte" in detail


def test_30018_is_reported_before_anything_is_blocked():
    rows = tally([make("MyBrand", "+9715012345678", 30018)])
    state, detail = verdict(rows[("MyBrand", "971")], {"MyBrand"})
    assert state == "warned"
    assert "30018" in detail


def test_working_sender_missing_from_every_service_is_its_own_state():
    rows = tally([make("Ghost", "+33612345678")])
    assert verdict(rows[("Ghost", "33")], {"MyBrand"})[0] == "not-in-pool"
    # With the services unread there is nothing to compare against, so no claim.
    assert verdict(rows[("Ghost", "33")], None)[0] == "delivering"


def test_only_alphanumeric_senders_are_counted():
    assert tally([make("+15005550006", "+33612345678"),
                  make("12345", "+33612345678")]) == {}
    assert sender_kind("MyBrand") == "alphanumeric"
    assert sender_kind("12345") == "short-code"


def test_dial_code_prefers_the_longest_match():
    assert dial_code("+971501234567") == "971"
    assert dial_code("+919812345678") == "91"
    assert dial_code("07700900123") is None
