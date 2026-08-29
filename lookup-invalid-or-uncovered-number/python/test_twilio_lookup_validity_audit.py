from twilio_lookup_validity_audit import classify, explain, shape

VALID = {"valid": True, "phone_number": "+15550109999", "country_code": "US"}


def test_national_format_is_caught_without_a_lookup():
    state, detail = classify("(555) 010-9999", 0, None)
    assert state == "not-e164"
    assert "21211" in detail


def test_punctuation_after_the_plus_is_still_not_e164():
    assert shape("+1 555 010 9999") is not None
    assert classify("+1 555 010 9999", 0, None)[0] == "not-e164"


def test_valid_false_reports_the_validation_error_in_words():
    state, detail = classify("+15550109", 200,
                             {"valid": False, "validation_errors": ["TOO_SHORT"]})
    assert state == "invalid"
    assert "too few digits" in detail


def test_a_valid_number_stored_in_another_form_is_its_own_finding():
    # 200, valid true, and the send still fails: you send what is in the row.
    assert classify("+1-555-010-9999", 200, VALID)[0] == "not-e164"
    assert classify("+15550109999 ", 200, VALID)[0] == "ok"


def test_normalised_difference_is_reported_rather_than_passed():
    state, detail = classify("+15550109998", 200, VALID)
    assert state == "renormalise"
    assert "+15550109999" in detail


def test_404_and_60600_are_different_rows():
    assert classify("+15550109999", 404, {"code": 20404})[0] == "not-found"
    assert classify("+15550109999", 400, {"code": 60600})[0] == "uncovered"
    assert classify("+15550109999", 429, {"code": 20429})[0] == "lookup-error"


def test_unknown_validation_codes_survive_the_translation():
    assert explain(["SOMETHING_NEW"]) == "SOMETHING_NEW"
    assert explain([]) == "no reason given"
