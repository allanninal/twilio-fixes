from twilio_verify_send_attempts_audit import gaps_seconds, verdict


def at(second, channel="sms"):
    return {"channel": channel,
            "time": "2026-03-04T12:%02d:%02dZ" % divmod(second, 60)}


def test_five_sends_is_the_exhausted_budget():
    state, detail = verdict({"send_code_attempts": [at(s * 40) for s in range(5)],
                             "status": "pending"})
    assert state == "burned"
    assert "60203" in detail


def test_four_sends_while_pending_is_one_tap_away():
    state, detail = verdict({"send_code_attempts": [at(s * 40) for s in range(4)],
                             "status": "pending"})
    assert state == "one-left"
    assert "still open" in detail


def test_three_sends_seconds_apart_is_a_machine_not_a_person():
    state, detail = verdict({"send_code_attempts": [at(0), at(4), at(9)],
                             "status": "pending"})
    assert state == "no-cooldown"
    assert "Fastest gap 4s" in detail


def test_the_same_count_spaced_like_a_human_is_fine():
    state, _ = verdict({"send_code_attempts": [at(0), at(45), at(95)],
                        "status": "pending"})
    assert state == "ok"


def test_a_channel_escalation_still_spends_from_the_same_budget():
    state, detail = verdict({"send_code_attempts": [at(0), at(60, "call")],
                             "status": "pending"})
    assert state == "ok"
    assert "sms, call" in detail


def test_one_send_is_the_design():
    assert verdict({"send_code_attempts": [at(0)], "status": "pending"})[0] == "ok"
    assert verdict({"status": "pending"})[0] == "ok"


def test_an_unreadable_timestamp_costs_one_gap_not_the_verification():
    sends = [at(0), {"channel": "sms", "time": "whenever"}, at(4)]
    assert gaps_seconds(sends) == [4.0]
    assert verdict({"send_code_attempts": sends, "status": "pending"})[0] == "no-cooldown"
