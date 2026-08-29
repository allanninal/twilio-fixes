import datetime

from twilio_a2p_campaign_wait_audit import age_days, verdict

IN_PROGRESS = {"sid": "QE0123456789", "campaign_status": "IN_PROGRESS"}
NOW = datetime.datetime(2026, 8, 30, tzinfo=datetime.timezone.utc)


def test_inside_the_sla_is_waiting_not_a_finding():
    state, detail = verdict(IN_PROGRESS, 3.0, sla_days=7)
    assert state == "waiting"
    assert "do not enable US sends" in detail


def test_past_the_sla_is_overdue():
    state, detail = verdict(IN_PROGRESS, 9.0, sla_days=7)
    assert state == "overdue"
    assert "30034" in detail


def test_past_three_weeks_is_a_support_ticket():
    state, _ = verdict(IN_PROGRESS, 25.0, sla_days=7, escalate_days=21)
    assert state == "escalate"


def test_in_progress_with_errors_is_already_decided():
    # The status lags the outcome. Waiting longer here achieves nothing.
    state, detail = verdict(dict(IN_PROGRESS, errors=[{"error_code": 30886}]), 2.0)
    assert state == "waiting-with-errors"
    assert "1 entry" in detail


def test_a_campaign_id_while_still_in_progress_is_a_disagreement():
    state, _ = verdict(dict(IN_PROGRESS, campaign_id="CX123"), 2.0)
    assert state == "waiting-with-campaign-id"


def test_verified_without_a_campaign_id_is_not_reported_as_live():
    state, _ = verdict({"campaign_status": "VERIFIED", "campaign_id": None}, 30.0)
    assert state == "verified-no-campaign-id"


def test_failed_is_a_rejection_not_a_queue():
    state, detail = verdict({"campaign_status": "FAILED"}, 30.0)
    assert state == "not-waiting"
    assert "errors[]" in detail


def test_age_days_reads_the_trailing_z_timestamp():
    assert round(age_days("2026-08-23T00:00:00Z", NOW)) == 7
    assert age_days("not a date", NOW) is None
