from twilio_trial_account_audit import outbound_profile, verdict

TRIAL = {"sid": "AC1", "type": "Trial"}
FULL = {"sid": "AC1", "type": "Full"}


def test_a_full_account_is_never_a_finding():
    state, detail = verdict(FULL, {"+14155550100"})
    assert state == "upgraded"
    assert "prefix" in detail


def test_trial_with_a_handful_of_testers_is_not_reported_as_an_incident():
    state, _ = verdict(TRIAL, {"+14155550100", "+14155550101"})
    assert state == "trial-idle"


def test_more_destinations_than_the_lifetime_cap_is_production_traffic():
    dests = {"+1415555010%d" % i for i in range(6)}
    state, detail = verdict(TRIAL, dests, days=7)
    assert state == "trial-in-production"
    assert "6 distinct" in detail


def test_one_21608_outranks_a_small_destination_count():
    state, detail = verdict(TRIAL, {"+14155550100"}, refused=1)
    assert state == "trial-blocked"
    assert "21608" in detail


def test_a_missing_type_field_is_not_read_as_upgraded():
    assert verdict({"sid": "AC1"}, set())[0] == "unknown"


def test_type_is_compared_case_insensitively():
    assert verdict({"sid": "AC1", "type": "trial"}, set())[0] == "trial-idle"


def test_inbound_rows_do_not_count_as_destinations():
    dests, refused = outbound_profile([
        {"direction": "inbound", "to": "+14155550100"},
        {"direction": "outbound-api", "to": "+14155550101"},
        {"direction": "outbound-api", "to": "+14155550102", "error_code": 21608},
    ])
    assert dests == {"+14155550101", "+14155550102"}
    assert refused == 1


def test_error_codes_are_compared_as_strings_or_integers():
    _, refused = outbound_profile([
        {"to": "+1", "error_code": "21608"},
        {"to": "+2", "error_code": 21608},
        {"to": "+3", "error_code": 30044},
    ])
    assert refused == 2
