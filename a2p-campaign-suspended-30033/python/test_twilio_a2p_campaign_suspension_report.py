from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

from twilio_a2p_campaign_suspension_report import (ordered, recipients,
                                                   sender_key, verdict)

T0 = datetime(2026, 8, 24, 12, 0, tzinfo=timezone.utc)


def at(seconds, **kw):
    """One Message row, dated the way Twilio dates them."""
    row = {"date_sent": format_datetime(T0 + timedelta(seconds=seconds)),
           "messaging_service_sid": "MG1", "to": "+15550000001"}
    row.update(kw)
    return row


def test_a_window_with_no_30033_is_clean():
    state, _ = verdict([at(0), at(60, error_code=30007)])
    assert state == "clean"


def test_sends_continuing_after_the_onset_are_counted_separately():
    state, detail = verdict([at(0), at(60, error_code=30033),
                             at(120, error_code=30033),
                             at(180, error_code=30033)])
    assert state == "still-pushing"
    assert "2 of them after the first" in detail


def test_traffic_that_stopped_after_the_onset_is_its_own_state():
    state, detail = verdict([at(0), at(60, error_code=30033), at(120)])
    assert state == "stopped"
    assert "open until Support" in detail


def test_a_sender_that_appears_only_after_the_onset_is_a_reroute():
    # The dangerous one. MG2 carried nothing before the suspension and is
    # carrying the same traffic afterwards.
    state, detail = verdict([at(0), at(60, error_code=30033),
                             at(120, messaging_service_sid="MG2")])
    assert state == "rerouted"
    assert "MG2" in detail
    assert "termination" in detail


def test_a_window_opening_on_a_30033_refuses_to_guess_at_reroutes():
    # With nothing before the onset every sender looks new, so the check is
    # skipped and the report says to widen the window instead.
    state, detail = verdict([at(0, error_code=30033),
                             at(60, messaging_service_sid="MG2"),
                             at(120, error_code=30033)])
    assert state == "still-pushing"
    assert "widen --days" in detail


def test_retries_are_counted_as_rows_and_recipients_separately():
    rows = [at(0), at(60, error_code=30033), at(70, error_code=30033),
            at(80, error_code=30033)]
    assert recipients(rows[1:]) == 1
    assert "3 x 30033 over 1 recipient(s)" in verdict(rows)[1]


def test_the_messaging_service_wins_over_the_from_number():
    assert sender_key({"messaging_service_sid": "MG1", "from": "+15550001"}) == "MG1"
    assert sender_key({"from": "+15550001"}) == "+15550001"


def test_an_unparseable_date_keeps_its_row_instead_of_dropping_it():
    rows = ordered([{"date_sent": "not a date", "error_code": 30033}, at(0)])
    assert len(rows) == 2
    assert verdict(rows)[0] != "clean"
