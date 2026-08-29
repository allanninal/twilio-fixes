from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

from twilio_a2p_throughput_report import (mps_ceiling, per_minute, peak, verdict)

T0 = datetime(2026, 8, 24, 12, 0, tzinfo=timezone.utc)

RATE_LIMITS = {"carriers": [{"carrier": "att", "mps": 12},
                            {"carrier": "tmobile", "mps": 4.5},
                            {"carrier": "verizon", "mps": 30}]}


def at(seconds, **kw):
    row = {"date_sent": format_datetime(T0 + timedelta(seconds=seconds)),
           "to": "+1555000%04d" % seconds}
    row.update(kw)
    return row


def burst(count, *, second=0, **kw):
    """count messages inside one minute, so the minute bucket sees all of them."""
    return [at(second + (i % 50), **kw) for i in range(count)]


def test_a_window_with_no_30022_is_clean():
    state, detail = verdict(burst(120), 4.5)
    assert state == "clean"
    assert "4.50/s" in detail


def test_a_peak_above_the_ceiling_says_throttle():
    rows = burst(500) + burst(6, error_code=30022)
    state, detail = verdict(rows, 4.5)
    assert state == "over-the-ceiling"
    assert "8.43/s" in detail and "4.50/s" in detail


def test_failures_under_the_ceiling_are_a_sub_second_burst():
    # 60 sends in the minute is 1/s on average, well under 4.5, and it still
    # 30022s: the batch went out inside one second.
    rows = burst(60) + burst(5, error_code=30022)
    state, detail = verdict(rows, 4.5)
    assert state == "under-the-ceiling"
    assert "inside a second" in detail


def test_failures_piled_on_one_handset_are_per_recipient_throttling():
    rows = burst(60) + [at(i, to="+15550009999", error_code=30022) for i in range(6)]
    state, detail = verdict(rows, 4.5)
    assert state == "per-recipient"
    assert "+15550009999" in detail


def test_no_published_mps_is_reported_rather_than_compared():
    state, detail = verdict(burst(60) + burst(5, error_code=30022), None)
    assert state == "no-ceiling-published"
    assert "VERIFIED" in detail


def test_the_lowest_carrier_mps_is_the_one_that_binds():
    assert mps_ceiling(RATE_LIMITS) == 4.5


def test_an_absent_or_shapeless_rate_limits_yields_no_ceiling():
    assert mps_ceiling(None) is None
    assert mps_ceiling({"carriers": [{"carrier": "att", "daily_cap": 200000}]}) is None


def test_buckets_are_minutes_not_seconds():
    buckets = per_minute([at(0), at(30), at(59), at(60)])
    assert len(buckets) == 2
    assert peak(buckets)[1] == 3
