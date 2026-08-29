from twilio_concurrency_probe import concurrency_of, verdict


def test_the_header_is_read_whatever_its_casing():
    assert concurrency_of({"Twilio-Concurrent-Requests": "7"}) == 7
    assert concurrency_of({"twilio-concurrent-requests": " 12 "}) == 12


def test_a_missing_or_unusable_header_is_none_rather_than_zero():
    assert concurrency_of({}) is None
    assert concurrency_of({"Content-Type": "application/json"}) is None
    assert concurrency_of({"Twilio-Concurrent-Requests": "many"}) is None


def test_no_header_anywhere_is_reported_as_unmeasurable():
    state, detail = verdict([None, None, None])
    assert state == "no-header"
    assert "3 sample(s)" in detail


def test_samples_with_no_ceiling_are_an_observation_not_a_finding():
    state, detail = verdict([3, 5, 4])
    assert state == "unmeasured"
    assert "peak concurrency 5" in detail


def test_a_quiet_account_against_a_real_ceiling_has_headroom():
    state, _ = verdict([3, 5, 4], limit=100)
    assert state == "headroom"


def test_seventy_percent_of_the_ceiling_is_close_enough_to_warn():
    state, detail = verdict([40, 70, 55], limit=100)
    assert state == "near-limit"
    assert "70%" in detail


def test_touching_the_ceiling_is_the_20429():
    state, detail = verdict([98, 100], limit=100)
    assert state == "at-limit"
    assert "20429" in detail


def test_an_observed_429_outranks_every_reading():
    state, detail = verdict([2, 3], limit=100, saw_429=True)
    assert state == "throttled"
    assert "a peak concurrency of 3" in detail


def test_a_429_with_no_readings_still_reports_rather_than_crashing():
    state, _ = verdict([None], limit=100, saw_429=True)
    assert state == "throttled"


def test_the_warn_ratio_is_adjustable():
    assert verdict([50], limit=100, warn_ratio=0.4)[0] == "near-limit"
    assert verdict([50], limit=100, warn_ratio=0.9)[0] == "headroom"
