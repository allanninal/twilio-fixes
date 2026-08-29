from twilio_delivery_observability_audit import message_streams, verdict

SINK = "DG11111111111111111111111111111111"


def sink(status="active", sid=SINK):
    return {"sid": sid, "status": status, "sink_type": "webhook"}


def sub(types, sink_sid=SINK):
    return {"sid": "DF1", "sink_sid": sink_sid,
            "types": [{"type": t} for t in types]}


def test_a_messaging_subscription_on_an_active_sink_is_live():
    streams = message_streams(
        [sink()], [sub(["com.twilio.messaging.message.delivered",
                        "com.twilio.messaging.message.failed"])])
    assert streams == {"live": [SINK], "broken": []}


def test_voice_events_are_not_delivery_observability():
    streams = message_streams([sink()], [sub(["com.twilio.voice.insights.call-summary"])])
    assert streams == {"live": [], "broken": []}


def test_a_sink_that_is_not_active_is_broken_not_live():
    streams = message_streams(
        [sink(status="failed")], [sub(["com.twilio.messaging.message.delivered"])])
    assert streams["live"] == []
    assert streams["broken"] == [(SINK, "failed")]


def test_a_subscription_pointing_at_no_sink_at_all_is_broken():
    streams = message_streams([], [sub(["com.twilio.messaging.message.sent"])])
    assert streams["broken"] == [(SINK, "missing")]


def test_a_service_with_no_callback_and_no_stream_is_blind():
    state, detail = verdict({"sid": "MG1", "status_callback": None,
                             "fallback_url": None})
    assert state == "blind"
    assert "com.twilio.messaging.message." in detail
    assert "No fallback_url either." in detail


def test_the_status_callback_settles_it():
    state, detail = verdict({"status_callback": "https://app.example.com/twilio/status",
                             "fallback_url": "https://app.example.com/twilio/fallback"})
    assert state == "callback"
    assert "No fallback_url" not in detail


def test_event_streams_counts_when_the_sink_is_active():
    state, _ = verdict({"status_callback": ""}, {"live": [SINK], "broken": []})
    assert state == "streamed"


def test_a_failed_sink_is_worse_than_nothing_and_says_so():
    state, detail = verdict({"status_callback": ""},
                            {"live": [], "broken": [(SINK, "failed")]})
    assert state == "sink-failed"
    assert "Believed working" in detail
