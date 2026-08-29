from twilio_caller_id_reputation_audit import seconds, tally, verdict


def call(frm, status, duration="0"):
    return {"from": frm, "status": status, "duration": duration}


def test_duration_parses_from_the_string_the_api_returns():
    assert seconds("45") == 45
    assert seconds(None) == 0
    assert seconds("") == 0
    assert seconds("n/a") == 0


def test_unanswered_calls_count_as_attempts_and_not_towards_the_mean():
    # The mistake that makes this whole check useless: a dialer whose calls ring
    # out looks fine if their zero durations are averaged in.
    calls = [call("+15005550006", "completed", "120"),
             call("+15005550006", "no-answer"),
             call("+15005550006", "busy")]
    row = tally(calls)["+15005550006"]
    assert row == {"attempts": 3, "completed": 1, "answered_seconds": 120,
                   "blocked": 0}


def test_calls_still_in_flight_are_excluded_from_the_denominator():
    calls = [call("+15005550006", "completed", "60"),
             call("+15005550006", "in-progress"),
             call("+15005550006", "queued")]
    assert tally(calls)["+15005550006"]["attempts"] == 1


def test_a_blocked_number_with_no_calls_in_the_window_still_appears():
    rows = tally([], {"+15005550006": 4})
    assert rows["+15005550006"]["blocked"] == 4
    assert verdict(rows["+15005550006"])[0] == "blocked"


def test_a_block_outranks_every_other_signal():
    stats = {"attempts": 500, "completed": 480, "answered_seconds": 96000,
             "blocked": 7}
    state, detail = verdict(stats)
    assert state == "blocked"
    assert "carrier side" in detail


def test_too_few_attempts_is_reported_as_thin_rather_than_scored():
    state, detail = verdict({"attempts": 4, "completed": 0, "answered_seconds": 0})
    assert state == "thin"
    assert "0 of 4" in detail


def test_low_answer_rate_and_short_calls_together_are_the_at_risk_profile():
    stats = {"attempts": 400, "completed": 40, "answered_seconds": 320}
    state, detail = verdict(stats)
    assert state == "at-risk"
    assert "10%" in detail
    assert "8s" in detail


def test_short_calls_alone_are_their_own_state():
    stats = {"attempts": 100, "completed": 90, "answered_seconds": 900}
    state, detail = verdict(stats)
    assert state == "short-calls"
    assert "under 30s" in detail


def test_a_low_answer_rate_on_long_calls_is_a_different_finding():
    stats = {"attempts": 200, "completed": 40, "answered_seconds": 8000}
    state, detail = verdict(stats)
    assert state == "low-answer"
    assert "labelled" in detail


def test_a_healthy_number_reports_the_two_numbers_that_matter():
    stats = {"attempts": 200, "completed": 150, "answered_seconds": 30000}
    state, detail = verdict(stats)
    assert state == "healthy"
    assert "150 of 200" in detail
    assert "200s" in detail
