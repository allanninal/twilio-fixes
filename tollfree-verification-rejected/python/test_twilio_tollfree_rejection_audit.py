import datetime

from twilio_tollfree_rejection_audit import (is_structural, reason_codes,
                                             submission_gaps, verdict)

NOW = datetime.datetime(2026, 8, 30, tzinfo=datetime.timezone.utc)


def make(**kw):
    record = {"sid": "HH00000000000000000000000000000001",
              "status": "TWILIO_REJECTED",
              "rejection_reason": "opt-in evidence was not found on the website",
              "rejection_reasons": [{"code": 30452,
                                     "description": "opt-in not documented"}],
              "error_code": None,
              "edit_allowed": True,
              "edit_expiration": "2026-09-05T00:00:00Z",
              "business_website": "https://example.com",
              "use_case_categories": ["TWO_FACTOR_AUTHENTICATION"],
              "use_case_summary": "One-time passcodes sent to customers who ask "
                                  "for them at sign-in.",
              "opt_in_type": "WEB_FORM"}
    record.update(kw)
    return record


def test_a_prohibited_category_beats_an_open_edit_window():
    # The case the whole script exists for. edit_allowed is true, so a naive
    # reader sends somebody off to reword a summary that was never the problem.
    state, detail = verdict(make(rejection_reasons=[{"code": 30469}]), NOW)
    assert state == "structural"
    assert "regardless of local legality" in detail
    assert "30469" in detail


def test_codes_classify_the_same_as_integers_or_strings():
    assert is_structural(["30469"]) is True
    assert is_structural([30469]) is True
    assert is_structural(["30452"]) is False
    assert is_structural(["not a code", None]) is False


def test_codes_are_collected_from_the_array_and_the_top_level():
    codes = reason_codes(make(rejection_reasons=[{"code": 30452},
                                                 {"error_code": "30453"}],
                              error_code=30452))
    assert codes == ["30452", "30453"]
    assert reason_codes(make(rejection_reasons=[], error_code=None)) == []


def test_an_open_window_is_the_cheap_path():
    state, detail = verdict(make(), NOW)
    assert state == "editable"
    assert "6 day(s) from now" in detail


def test_a_window_about_to_close_is_its_own_state():
    state, detail = verdict(make(edit_expiration="2026-08-31T00:00:00Z"), NOW)
    assert state == "edit-closing"
    assert "lose the cheap path" in detail


def test_an_expired_window_overrides_edit_allowed():
    state, detail = verdict(make(edit_expiration="2026-08-20T00:00:00Z"), NOW)
    assert state == "resubmit"
    assert "10 day(s) ago" in detail


def test_edit_allowed_false_is_a_fresh_submission():
    state, detail = verdict(make(edit_allowed=False), NOW)
    assert state == "resubmit"
    assert "back of the review queue" in detail


def test_a_record_that_is_not_a_rejection_is_left_alone():
    state, _ = verdict(make(status="TWILIO_APPROVED"), NOW)
    assert state == "not-rejected"


def test_gaps_name_what_the_reviewer_had_to_work_with():
    assert submission_gaps(make()) == []
    gaps = submission_gaps(make(business_website="", use_case_summary="OTPs",
                                use_case_categories=[], opt_in_type=""))
    assert len(gaps) == 4
    assert any("business_website" in g for g in gaps)
    assert any("4 character(s)" in g for g in gaps)
