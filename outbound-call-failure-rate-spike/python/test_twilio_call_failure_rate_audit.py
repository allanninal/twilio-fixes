from twilio_call_failure_rate_audit import dial_prefix, summarise, verdict


def calls(n, status, to="+15005550006", direction="outbound-api"):
    return [{"status": status, "to": to, "direction": direction} for _ in range(n)]


def test_prefix_uses_leading_digits_only():
    assert dial_prefix("+15005550006") == "+150"
    assert dial_prefix("+44 20 7946 0000", digits=2) == "+44"


def test_sip_and_client_destinations_are_their_own_buckets():
    assert dial_prefix("sip:pbx@example.com") == "sip"
    assert dial_prefix("client:alice") == "client"
    assert dial_prefix("") == "unknown"


def test_calls_still_in_flight_are_not_an_outcome():
    # Counting ringing calls would move the rate with the clock rather than
    # with anything that happened.
    assert summarise(calls(5, "ringing")) == {}


def test_inbound_calls_are_not_in_the_outbound_rate():
    assert summarise(calls(5, "failed", direction="inbound")) == {}


def test_buckets_split_on_direction_and_prefix():
    rows = (calls(3, "failed") + calls(2, "completed")
            + calls(4, "failed", direction="outbound-dial"))
    buckets = summarise(rows)
    assert set(buckets) == {("outbound-api", "+150"), ("outbound-dial", "+150")}
    assert buckets[("outbound-api", "+150")]["total"] == 5
    assert buckets[("outbound-dial", "+150")]["failed"] == 4


def test_a_small_bucket_is_never_elevated():
    state, detail = verdict({"total": 4, "failed": 3}, floor=20)
    assert state == "low-volume"
    assert "too few" in detail


def test_exactly_on_the_threshold_is_elevated():
    state, _ = verdict({"total": 100, "failed": 10}, floor=20, threshold=0.10)
    assert state == "elevated"


def test_just_below_the_threshold_is_ok():
    assert verdict({"total": 100, "failed": 9}, floor=20, threshold=0.10)[0] == "ok"


def test_everything_failing_is_not_reported_as_a_rate():
    state, detail = verdict({"total": 40, "failed": 40}, floor=20)
    assert state == "total-failure"
    assert "permission" in detail


def test_a_bucket_with_no_calls_does_not_divide_by_zero():
    assert verdict({"total": 0, "failed": 0})[0] == "low-volume"
