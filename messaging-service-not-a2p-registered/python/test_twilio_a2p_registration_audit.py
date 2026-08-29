from twilio_a2p_registration_audit import us_long_codes, verdict

REGISTERED = {"us_app_to_person_registered": True}
UNREGISTERED = {"us_app_to_person_registered": False}
VERIFIED = [{"sid": "QE0123456789", "campaign_status": "VERIFIED"}]


def test_unregistered_with_us_senders_is_an_outage():
    state, detail = verdict(UNREGISTERED, [], 3)
    assert state == "blocked"
    assert "30034" in detail


def test_unregistered_with_no_us_senders_is_not_the_same_finding():
    # Same missing campaign, but nothing is failing yet. Keeping these apart is
    # what makes the report worth reading on a big account.
    state, _ = verdict(UNREGISTERED, [], 0)
    assert state == "unregistered"


def test_verified_campaign_and_flag_agree():
    state, detail = verdict(REGISTERED, VERIFIED, 3)
    assert state == "registered"
    assert "QE0123456789" in detail


def test_campaign_in_progress_sends_like_no_campaign():
    state, detail = verdict(REGISTERED, [{"campaign_status": "IN_PROGRESS"}], 2)
    assert state == "campaign-in_progress"
    assert "no campaign at all" in detail


def test_suspended_campaign_is_not_reported_as_registered():
    state, _ = verdict(REGISTERED, [{"campaign_status": "SUSPENDED"}], 1)
    assert state == "campaign-suspended"


def test_flag_disagreeing_with_the_subresource_is_reported():
    state, _ = verdict(REGISTERED, [], 1)
    assert state == "inconsistent"


def test_toll_free_and_short_codes_are_not_10dlc_senders():
    pool = [{"phone_number": "+15550001111"}, {"phone_number": "+18885551234"},
            {"phone_number": "+447700900123"}, {"phone_number": "12345"}]
    assert us_long_codes(pool) == ["+15550001111"]
