import datetime

from twilio_recording_storage_audit import (daily_rate, older_than, parse_created,
                                            project, stored_minutes, verdict)

TODAY = datetime.date(2026, 8, 30)


def rec(created, duration="120"):
    return {"sid": "RE01", "date_created": created, "duration": duration}


def test_rfc_2822_dates_parse_and_iso_style_junk_does_not():
    assert parse_created("Tue, 18 Apr 2023 09:12:00 +0000") == datetime.date(2023, 4, 18)
    assert parse_created("not a date") is None
    assert parse_created(None) is None


def test_ages_are_measured_against_the_day_you_pass_in():
    stale, oldest = older_than([rec("Mon, 01 Jun 2026 00:00:00 +0000"),
                                rec("Sat, 01 Jun 2024 00:00:00 +0000")], 90, TODAY)
    assert stale == 1
    assert oldest == 820


def test_an_unparseable_row_is_skipped_rather_than_counted_as_new():
    stale, oldest = older_than([rec("garbage")], 90, TODAY)
    assert (stale, oldest) == (0, None)


def test_stored_minutes_add_up_and_ignore_bad_durations():
    assert stored_minutes([rec("x", "90"), rec("x", "30"), rec("x", None)]) == 2.0


def test_the_daily_rate_is_the_mean_of_the_priced_days():
    assert daily_rate([{"price": "1.00"}, {"price": "3.00"}]) == 2.0
    assert daily_rate([]) == 0.0


def test_the_projection_is_the_rate_over_a_year():
    assert project(0.5) == 182.5
    assert project(0.0) == 0.0


def test_no_recordings_and_no_spend_is_nothing_to_do():
    state, _ = verdict(0.0, 0.0, 0, 0, 90)
    assert state == "empty"


def test_historic_spend_with_nothing_stored_is_not_a_finding():
    state, detail = verdict(400.0, 0.0, 0, 0, 90)
    assert state == "billed-only"
    assert "in the past" in detail


def test_a_working_retention_job_reads_as_retained():
    state, detail = verdict(812.44, 0.4, 0, 1204, 90)
    assert state == "retained"
    assert "something is deleting them" in detail


def test_the_finding_is_the_projected_cost_not_the_file_count():
    state, detail = verdict(3200.0, 2.0, 38000, 40000, 90)
    assert state == "accumulating"
    assert "730.00 more over the next year" in detail


def test_stale_files_with_no_priced_usage_send_you_to_the_category_name():
    state, detail = verdict(0.0, 0.0, 12, 40, 90)
    assert state == "unpriced"
    assert "--category" in detail
