from twilio_sender_coverage_audit import coverage, has_capability

US_SMS = {"phone_number": "+12025550100", "country_code": "US", "capabilities": ["SMS"]}
US_MMS = {"phone_number": "+12025550101", "country_code": "US", "capabilities": ["SMS", "MMS"]}
GB_SMS = {"phone_number": "+447700900100", "country_code": "GB", "capabilities": ["SMS"]}
ALPHA = {"sid": "AS1", "alpha_sender": "ACME"}

US = {"country_code": "US", "needs_mms": False}
US_MEDIA = {"country_code": "US", "needs_mms": True}
GB = {"country_code": "GB", "needs_mms": False}


def test_a_us_number_covers_a_us_destination():
    state, detail = coverage({"phone_numbers": [US_SMS]}, US)
    assert state == "covered"
    assert "US" in detail


def test_alpha_senders_do_not_cover_the_us():
    # The whole note: the pool is populated and the destination is unreachable.
    state, detail = coverage({"alpha_senders": [ALPHA, ALPHA, ALPHA]}, US)
    assert state == "unreachable"
    assert "cannot deliver to US" in detail


def test_a_uk_only_pool_cannot_reach_the_us():
    assert coverage({"phone_numbers": [GB_SMS]}, US)[0] == "unreachable"


def test_media_needs_an_mms_capable_sender_in_that_country():
    state, detail = coverage({"phone_numbers": [US_SMS]}, US_MEDIA)
    assert state == "no-mms"
    assert "MediaUrl" in detail
    assert coverage({"phone_numbers": [US_SMS, US_MMS]}, US_MEDIA)[0] == "covered"


def test_an_empty_pool_is_21704_and_says_so():
    state, detail = coverage({}, US)
    assert state == "no-senders"
    assert "21704" in detail


def test_a_short_code_in_the_destination_country_counts():
    pool = {"short_codes": [{"short_code": "12345", "country_code": "US"}]}
    assert coverage(pool, US)[0] == "covered"


def test_a_non_north_american_gap_is_not_reported_as_unreachable():
    # Selection may still pick a foreign long code, so this is a softer state.
    assert coverage({"phone_numbers": [US_SMS]}, GB)[0] == "no-local-sender"
    assert coverage({"phone_numbers": [US_SMS], "alpha_senders": [ALPHA]}, GB)[0] == "alpha-only"


def test_an_unresolved_country_is_never_guessed_at():
    assert coverage({"phone_numbers": [US_SMS]}, {"country_code": ""})[0] == "unresolved"


def test_capabilities_match_across_both_spellings():
    assert has_capability({"capabilities": ["SMS", "MMS"]}, "mms")
    assert has_capability({"capabilities": {"sms": True, "mms": True}}, "MMS")
    assert not has_capability({"capabilities": ["SMS"]}, "MMS")
