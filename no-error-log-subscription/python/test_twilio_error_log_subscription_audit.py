from twilio_error_log_subscription_audit import is_error_log_type, verdict

ERRORS = "com.twilio.error-logs.error-log.logged"
MESSAGES = "com.twilio.messaging.message.delivered"


def sub(sid="DF01", sink="DG01"):
    return {"sid": sid, "sink_sid": sink, "description": "warehouse"}


def test_an_account_with_no_subscriptions_keeps_nothing_past_the_window():
    state, detail = verdict([], {}, {})
    assert state == "none"
    assert "30 days" in detail


def test_a_busy_pipeline_with_no_error_types_is_just_as_blind():
    state, detail = verdict([sub("DF01"), sub("DF02")],
                            {"DF01": [MESSAGES], "DF02": [MESSAGES]},
                            {"DG01": "active"})
    assert state == "no-error-logs"
    assert "whatever else is being streamed" in detail


def test_error_logs_into_an_active_sink_is_coverage():
    state, _ = verdict([sub()], {"DF01": [MESSAGES, ERRORS]}, {"DG01": "active"})
    assert state == "covered"


def test_error_logs_into_a_failed_sink_is_subscribed_and_not_delivering():
    state, detail = verdict([sub()], {"DF01": [ERRORS]}, {"DG01": "failed"})
    assert state == "sink-not-active"
    assert "failed" in detail


def test_a_sink_sid_that_is_not_in_the_list_is_unresolved_rather_than_fine():
    state, detail = verdict([sub(sink="DG99")], {"DF01": [ERRORS]}, {"DG01": "active"})
    assert state == "sink-not-active"
    assert "unresolved" in detail


def test_one_live_error_subscription_outweighs_the_dead_ones_beside_it():
    state, _ = verdict([sub("DF01", "DG_DEAD"), sub("DF02", "DG01")],
                       {"DF01": [ERRORS], "DF02": [ERRORS]},
                       {"DG01": "active", "DG_DEAD": "failed"})
    assert state == "covered"


def test_the_type_is_matched_on_the_product_prefix_not_the_whole_string():
    assert is_error_log_type(ERRORS) is True
    assert is_error_log_type("com.twilio.error-logs.error-log.logged.v2") is True
    assert is_error_log_type("COM.TWILIO.ERROR-LOGS.ERROR-LOG.LOGGED") is True
    assert is_error_log_type(MESSAGES) is False
    assert is_error_log_type(None) is False
