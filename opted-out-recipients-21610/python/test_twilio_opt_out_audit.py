from twilio_opt_out_audit import keyword_kind, tally, verdict

CONSUMER = "+15557654321"


def inbound(body):
    return {"sid": "SMin", "direction": "inbound", "from": CONSUMER,
            "to": "+15550001111", "body": body}


def rejected(sid):
    return {"sid": sid, "direction": "outbound-api", "from": "+15550001111",
            "to": CONSUMER, "status": "failed", "error_code": 21610}


def test_keyword_matching_follows_twilios_whole_body_rule():
    assert keyword_kind("STOP") == "out"
    assert keyword_kind("  stop  ") == "out"
    assert keyword_kind("Unsubscribe") == "out"
    assert keyword_kind("START") == "in"
    # The line that keeps complainers out of the suppression list.
    assert keyword_kind("STOP please") == ""
    assert keyword_kind("please stop sending these at 6am") == ""
    assert keyword_kind(None) == ""


def test_the_join_puts_the_inbound_stop_and_the_rejections_on_one_person():
    rows = tally([inbound("STOP"), rejected("SM1"), rejected("SM2")])
    assert set(rows) == {CONSUMER}
    assert rows[CONSUMER]["stops"] == 1
    assert rows[CONSUMER]["rejected"] == 2
    assert rows[CONSUMER]["sids"] == ["SM1", "SM2"]


def test_stop_seen_and_sends_afterwards_is_the_finding():
    state, detail = verdict({"rejected": 2, "stops": 1})
    assert state == "ignored-opt-out"
    assert "never reached your database" in detail


def test_rejections_with_no_stop_in_the_window_are_still_actionable():
    state, detail = verdict({"rejected": 3, "stops": 0})
    assert state == "invisible-opt-out"
    assert "no read API" in detail


def test_a_retry_loop_outranks_everything_else():
    state, detail = verdict({"rejected": 40, "stops": 1})
    assert state == "retry-loop"
    assert "not billed" not in detail
    assert "none are billed" in detail


def test_a_start_is_reported_as_a_different_sender_not_a_mistake():
    state, detail = verdict({"rejected": 1, "stops": 1, "starts": 1})
    assert state == "ignored-opt-out"
    assert "different sender" in detail


def test_stop_with_no_sends_afterwards_is_correct_behaviour():
    state, detail = verdict({"rejected": 0, "stops": 1})
    assert state == "suppressed"
    assert verdict({"rejected": 0, "stops": 0})[0] == "clean"
    assert "nothing has been sent" in detail
