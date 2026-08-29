from twilio_trunk_cps_audit import burst_profile, second_bucket, verdict

# Six starts inside one second, one in the next. The peak is six.
BURST = ["Tue, 31 Aug 2010 20:36:28 +0000"] * 6 + ["Tue, 31 Aug 2010 20:36:29 +0000"]


def test_rfc_2822_start_time_is_floored_to_the_second():
    assert second_bucket("Tue, 31 Aug 2010 20:36:28 +0000") == "2010-08-31T20:36:28Z"


def test_iso_timestamps_and_offsets_normalise_to_utc():
    assert second_bucket("2010-08-31T21:36:28+01:00") == "2010-08-31T20:36:28Z"
    assert second_bucket("2010-08-31T20:36:28Z") == "2010-08-31T20:36:28Z"


def test_an_unparseable_timestamp_is_dropped_rather_than_guessed():
    # Bucketed to the epoch it would stretch the span and flatten the peak.
    assert second_bucket("last tuesday") == ""
    assert second_bucket(None) == ""


def test_the_peak_is_the_busiest_single_second():
    p = burst_profile(BURST)
    assert p["calls"] == 7
    assert p["peak"] == 6
    assert p["at"] == "2010-08-31T20:36:28Z"
    assert p["active_seconds"] == 2
    assert p["span_seconds"] == 2


def test_an_empty_window_has_no_peak_and_no_span():
    p = burst_profile([])
    assert p == {"calls": 0, "peak": 0, "at": "", "active_seconds": 0,
                 "span_seconds": 0}
    assert verdict(p, 10)[0] == "no-calls"


def test_alerts_outrank_everything_and_quote_the_hiding_mean():
    state, detail = verdict(burst_profile(BURST), 5, alerts=44)
    assert state == "shedding"
    assert "44 call(s) rejected" in detail
    assert "3.50 per second" in detail


def test_a_peak_on_the_ceiling_is_its_own_state():
    state, detail = verdict(burst_profile(BURST), 6)
    assert state == "at-ceiling"
    assert "one call larger" in detail


def test_a_peak_above_the_ceiling_with_no_alert_says_so():
    state, detail = verdict(burst_profile(BURST), 4)
    assert state == "over-ceiling"
    assert "spread across trunks" in detail


def test_the_warning_level_code_is_reported_before_anything_is_lost():
    state, detail = verdict(burst_profile(BURST), 20, warnings=3)
    assert state == "warned"
    assert "error-only sweep" in detail


def test_a_burst_well_under_the_ceiling_is_still_the_finding():
    # 6 in one second against a mean of 3.5 is not four times the mean, so
    # stretch the window: the same six calls over a quieter minute are.
    quiet = BURST + ["Tue, 31 Aug 2010 20:37:%02d +0000" % s for s in range(30, 50)]
    state, detail = verdict(burst_profile(quiet), 50)
    assert state == "bursty"
    assert "no hourly average" in detail


def test_a_flat_stream_under_the_ceiling_is_clean():
    flat = ["Tue, 31 Aug 2010 20:36:%02d +0000" % s for s in range(10, 40)]
    state, _ = verdict(burst_profile(flat), 5)
    assert state == "within-ceiling"
