from twilio_verified_caller_ids_audit import destinations_used, e164, verdict

TRIAL = {"sid": "AC1", "type": "Trial"}
FULL = {"sid": "AC1", "type": "Full"}


def cid(number):
    return {"phone_number": number}


def test_an_upgraded_account_is_not_gated_by_the_list():
    state, detail = verdict(FULL, [cid("+14155550100")], {"+14155550999"})
    assert state == "not-trial"
    assert "no longer gates" in detail


def test_three_verified_numbers_is_the_lifetime_quota():
    state, detail = verdict(
        TRIAL, [cid("+14155550100"), cid("+14155550101"), cid("+14155550102")],
        {"+14155550100", "+14155550999"})
    assert state == "spent"
    assert "does not return a slot" in detail


def test_an_unverified_destination_with_slots_left_says_how_many_remain():
    state, detail = verdict(TRIAL, [cid("+14155550100")], {"+14155550999"})
    assert state == "unverified"
    assert "2 slot(s) left" in detail


def test_formatting_differences_are_not_reported_as_unverified():
    state, _ = verdict(TRIAL, [cid("+1 (415) 555-0100")], {"+14155550100"})
    assert state == "ok"


def test_everything_covered_and_slots_left_passes():
    state, detail = verdict(TRIAL, [cid("+14155550100")], {"+14155550100"})
    assert state == "ok"
    assert "2 slot(s) left" in detail


def test_e164_keeps_only_digits():
    assert e164("+1 (415) 555-0100") == "+14155550100"
    assert e164("") == ""
    assert e164(None) == ""


def test_inbound_rows_are_not_destinations_and_21608s_are_collected():
    used, refused = destinations_used([
        {"direction": "inbound", "to": "+14155550100"},
        {"direction": "outbound-api", "to": "+14155550101"},
        {"direction": "outbound-api", "to": "+14155550999", "error_code": "21608"},
    ])
    assert used == {"+14155550101", "+14155550999"}
    assert refused == {"+14155550999"}
