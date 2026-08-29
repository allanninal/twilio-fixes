from twilio_a2p_brand_audit import failure_lines, verdict


def test_failed_brand_reports_the_code_and_the_fields():
    state, detail = verdict({
        "status": "FAILED",
        "errors": [{"code": 30799, "description": "Unable to verify registration "
                    "details", "fields": ["business_registration_identifier"]}],
    })
    assert state == "failed"
    assert "30799" in detail
    assert "business_registration_identifier" in detail


def test_deprecated_prose_is_used_but_labelled():
    # failure_reason and brand_feedback are superseded by errors[]. If they are
    # all that is populated, say so rather than presenting them as the answer.
    state, detail = verdict({"status": "FAILED", "errors": [],
                             "failure_reason": "EIN does not match"})
    assert state == "failed-deprecated-reason"
    assert "deprecated" in detail


def test_errors_win_over_the_deprecated_fields():
    source, lines = failure_lines({"errors": [{"code": "30799"}],
                                   "brand_feedback": "old text"})
    assert source == "errors"
    assert len(lines) == 1


def test_failed_with_nothing_at_all_mentions_the_resubmission_limit():
    state, detail = verdict({"status": "FAILED"})
    assert state == "failed-unexplained"
    assert "21724" in detail


def test_approved_without_a_tcr_id_is_a_disagreement():
    state, _ = verdict({"status": "APPROVED", "tcr_id": None})
    assert state == "approved-no-tcr-id"


def test_approved_with_a_tcr_id_is_clean():
    state, detail = verdict({"status": "APPROVED", "tcr_id": "BRAND1234"})
    assert state == "approved"
    assert "BRAND1234" in detail


def test_suspended_is_not_folded_into_failed():
    state, detail = verdict({"status": "SUSPENDED"})
    assert state == "suspended"
    assert "every campaign" in detail


def test_in_review_is_not_a_finding():
    state, _ = verdict({"status": "IN_REVIEW", "tcr_id": None})
    assert state == "in-review"
