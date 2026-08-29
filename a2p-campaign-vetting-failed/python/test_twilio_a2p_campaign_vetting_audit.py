from twilio_a2p_campaign_vetting_audit import (classify_error, named_fields,
                                                  verdict)

FAILED = {"sid": "QE0123456789", "campaign_status": "FAILED"}


def test_failed_on_an_editable_code_names_the_field_to_change():
    state, detail = verdict(dict(FAILED, errors=[{"error_code": 30893,
                                                  "fields": ["message_samples"]}]))
    assert state == "failed-editable"
    assert "message_samples" in detail


def test_content_rejection_is_not_an_edit():
    # 30884 is a spam risk judgement. Rewriting the description does not clear it,
    # and reporting it in the same bucket costs weeks.
    state, detail = verdict(dict(FAILED, errors=[{"error_code": "30884"}]))
    assert state == "failed-structural"
    assert "will not clear" in detail


def test_ein_code_points_at_the_brand_not_the_campaign():
    state, _ = verdict(dict(FAILED, errors=[{"error_code": 30898}]))
    assert state == "failed-at-the-brand"


def test_failed_with_an_empty_errors_array_is_its_own_state():
    state, detail = verdict(dict(FAILED, errors=[]))
    assert state == "failed-unexplained"
    assert "guess" in detail


def test_an_error_object_spelled_code_is_still_read():
    # The campaign resource says error_code and the brand resource says code.
    bucket, field, _why = classify_error({"code": "30886"})
    assert (bucket, field) == ("editable", "description")


def test_fields_from_the_api_win_over_the_table():
    assert named_fields([{"error_code": 30886, "fields": ["message_flow"]}]) == \
        ["message_flow"]


def test_in_progress_with_errors_is_not_reported_as_waiting():
    state, _ = verdict({"campaign_status": "IN_PROGRESS",
                        "errors": [{"error_code": 30909}]})
    assert state == "pending-with-errors"


def test_verified_campaign_is_clean():
    state, detail = verdict({"campaign_status": "VERIFIED", "sid": "QE0123456789"})
    assert state == "verified"
    assert "QE0123456789" in detail
