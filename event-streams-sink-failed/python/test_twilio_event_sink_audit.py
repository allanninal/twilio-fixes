from twilio_event_sink_audit import subscribers, verdict

SINK = "DG11111111111111111111111111111111"


def sink(status="active", kind="webhook", sid=SINK):
    return {"sid": sid, "status": status, "sink_type": kind,
            "description": "warehouse"}


def subscription(sid="DF1", sink_sid=SINK):
    return {"sid": sid, "sink_sid": sink_sid}


def test_subscribers_joins_on_sink_sid():
    feeds = subscribers([subscription("DF1"), subscription("DF2"),
                         subscription("DF3", "DG99")])
    assert feeds[SINK] == ["DF1", "DF2"]
    assert feeds["DG99"] == ["DF3"]


def test_a_subscription_with_no_sink_is_skipped_not_crashed_on():
    assert subscribers([{"sid": "DF1"}, {"sid": "DF2", "sink_sid": ""}]) == {}
    assert subscribers(None) == {}


def test_a_failed_sink_with_subscriptions_is_the_outage():
    state, detail = verdict(sink("failed"), ["DF1", "DF2"])
    assert state == "failed"
    assert "2 subscription(s)" in detail
    assert "being dropped" in detail


def test_a_failed_sink_nothing_feeds_is_litter_not_an_outage():
    state, detail = verdict(sink("failed"), [])
    assert state == "failed-detached"
    assert "left behind" in detail


def test_initialized_and_validating_never_delivered_anything():
    for status in ("initialized", "validating"):
        state, detail = verdict(sink(status), ["DF1"])
        assert state == "unvalidated"
        assert "never delivered a single event" in detail


def test_an_active_sink_with_no_subscription_delivers_nothing():
    # The failure mode people create while fixing the other one: the sink is
    # green in the list and carries no events at all.
    state, detail = verdict(sink("active"), [])
    assert state == "unused"
    assert "delivers nothing" in detail


def test_an_active_sink_with_a_subscription_is_healthy():
    state, detail = verdict(sink("active"), ["DF1"])
    assert state == "active"
    assert "DF1" in detail


def test_an_unrecognised_status_is_reported_rather_than_assumed_healthy():
    assert verdict(sink("paused"), ["DF1"])[0] == "unknown-status"
    assert verdict(sink(""), ["DF1"])[0] == "unknown-status"
