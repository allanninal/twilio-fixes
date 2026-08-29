from twilio_tollfree_verification_audit import pick_verification, verdict

SMS = {"sid": "PN0123456789", "phone_number": "+18885551234",
       "capabilities": {"sms": True, "voice": True}}


def test_no_verification_record_is_the_headline_finding():
    state, detail = verdict(SMS, None)
    assert state == "unverified"
    assert "30032" in detail


def test_pending_review_is_blocked_not_progress():
    # The point of the note: filing is not passing.
    state, detail = verdict(SMS, {"status": "PENDING_REVIEW"})
    assert state == "blocked-in-review"
    assert "blocked outright" in detail


def test_approved_is_the_only_state_that_can_send():
    state, detail = verdict(SMS, {"status": "TWILIO_APPROVED", "sid": "HH0123456789"})
    assert state == "verified"
    assert "HH0123456789" in detail


def test_rejection_reasons_are_read_from_the_array():
    state, detail = verdict(SMS, {
        "status": "TWILIO_REJECTED", "edit_allowed": True,
        "edit_expiration": "2026-09-05T00:00:00Z",
        "rejection_reasons": [{"code": 30469,
                               "description": "Illegal substances or articles"}]})
    assert state == "rejected-editable"
    assert "30469" in detail
    assert "2026-09-05" in detail


def test_rejection_falls_back_to_the_prose_field():
    state, detail = verdict(SMS, {"status": "TWILIO_REJECTED", "edit_allowed": False,
                                  "rejection_reason": "opt-in evidence missing"})
    assert state == "rejected-final"
    assert "opt-in evidence missing" in detail


def test_a_voice_only_toll_free_number_is_not_a_finding():
    state, _ = verdict({"capabilities": {"sms": False, "voice": True}}, None)
    assert state == "voice-only"


def test_an_approved_record_wins_over_a_newer_rejection():
    records = [{"status": "TWILIO_APPROVED", "date_updated": "2026-01-01T00:00:00Z"},
               {"status": "TWILIO_REJECTED", "date_updated": "2026-06-01T00:00:00Z"}]
    assert pick_verification(records)["status"] == "TWILIO_APPROVED"


def test_without_an_approval_the_newest_record_governs():
    records = [{"status": "TWILIO_REJECTED", "date_updated": "2026-01-01T00:00:00Z"},
               {"status": "PENDING_REVIEW", "date_updated": "2026-06-01T00:00:00Z"}]
    assert pick_verification(records)["status"] == "PENDING_REVIEW"
    assert pick_verification([]) is None
