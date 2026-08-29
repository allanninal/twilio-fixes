from twilio_a2p_brand_vetting_audit import verdict, vetting_state

STANDARD = {"sid": "BN0123456789", "status": "APPROVED", "brand_type": "STANDARD",
            "brand_score": None}


def test_an_approved_standard_brand_with_no_vetting_is_the_finding():
    state, detail = verdict(STANDARD)
    assert state == "unvetted"
    assert "lowest tier" in detail


def test_a_score_of_zero_is_a_score():
    # 0 is the bottom of a 0 to 100 scale, not a missing value. A truthiness
    # check reports this brand as unvetted and buys a second vetting for it.
    state, detail = verdict(dict(STANDARD, brand_score=0))
    assert state == "scored"
    assert "0" in detail


def test_sole_proprietor_brands_are_never_scored():
    state, _ = verdict(dict(STANDARD, brand_type="SOLE_PROPRIETOR"))
    assert state == "not-eligible"


def test_low_volume_standard_is_not_reported_either():
    assert verdict(dict(STANDARD,
                        brand_type="LOW_VOLUME_STANDARD"))[0] == "not-eligible"


def test_the_skip_flag_is_named_when_nothing_was_ever_vetted():
    state, detail = verdict(dict(STANDARD, skip_automatic_sec_vet=True))
    assert state == "vetting-skipped"
    assert "skip_automatic_sec_vet" in detail


def test_a_failed_vetting_record_explains_the_null_score():
    state, _ = verdict(STANDARD, [{"vetting_status": "FAILED"}])
    assert state == "vetting-failed"


def test_a_pending_retry_outranks_the_failure_it_retries():
    assert vetting_state([{"vetting_status": "FAILED"},
                          {"vetting_status": "PENDING"}]) == "pending"


def test_success_with_no_score_is_reported_as_a_disagreement():
    state, detail = verdict(STANDARD, [{"vetting_status": "SUCCESS"}])
    assert state == "vetted-without-score"
    assert "disagree" in detail


def test_an_unapproved_brand_is_a_different_report():
    assert verdict(dict(STANDARD, status="PENDING"))[0] == "not-approved"
