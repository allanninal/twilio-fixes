from twilio_unreachable_handset_audit import (error_code, group,
                                              recipient_verdict, sender_verdict)


def unreachable(sid, to="+15557770001", sender="+15550001111"):
    return {"sid": sid, "to": to, "from": sender, "status": "undelivered",
            "error_code": 30003, "direction": "outbound-api"}


def delivered(sid, to="+15557770001", sender="+15550001111"):
    return {"sid": sid, "to": to, "from": sender, "status": "delivered",
            "error_code": None, "direction": "outbound-api"}


def test_error_code_reads_strings_and_numbers_the_same():
    assert error_code({"error_code": 30003}) == 30003
    assert error_code({"error_code": "30003"}) == 30003
    assert error_code({"error_code": None}) is None
    assert error_code({}) is None


def test_group_drops_recipients_that_never_failed():
    recipients, senders = group([unreachable("SM1"), delivered("SM2", to="+15557770002")])
    assert set(recipients) == {"+15557770001"}
    assert senders["+15550001111"]["total"] == 2
    assert senders["+15550001111"]["failed"] == 1


def test_group_counts_distinct_recipients_per_sender():
    msgs = [unreachable("SM%d" % i, to="+1555777%04d" % i) for i in range(5)]
    _, senders = group(msgs)
    assert senders["+15550001111"]["recipients"] == 5


def test_group_prefers_the_messaging_service_over_the_from_number():
    m = unreachable("SM1")
    m["messaging_service_sid"] = "MG1"
    _, senders = group([m])
    assert set(senders) == {"MG1"}


def test_group_ignores_inbound_messages():
    recipients, senders = group([{"sid": "SM1", "to": "+15550001111",
                                  "direction": "inbound", "status": "received"}])
    assert recipients == {}
    assert senders == {}


def test_one_failure_is_transient():
    state, detail = recipient_verdict({"hits": 1, "delivered": 0})
    assert state == "transient"
    assert "retry once" in detail


def test_a_number_that_also_delivers_is_flaky_and_stays_on_the_list():
    state, detail = recipient_verdict({"hits": 4, "delivered": 2})
    assert state == "flaky"
    assert "do not drop it" in detail


def test_repeated_failures_with_no_delivery_ever_go_to_lookup():
    state, detail = recipient_verdict({"hits": 4, "delivered": 0})
    assert state == "never-reached"
    assert "Lookup" in detail


def test_no_failures_is_a_clean_sender():
    state, detail = sender_verdict({"total": 900, "failed": 0})
    assert state == "clean"
    assert "900" in detail


def test_two_failures_are_too_few_to_mean_anything():
    state, _ = sender_verdict({"total": 4, "failed": 2, "recipients": 1})
    assert state == "isolated"


def test_many_failures_over_few_recipients_is_list_decay():
    # Same failure count as the blocked-sender case below; the spread is the
    # only thing that distinguishes them.
    state, detail = sender_verdict({"total": 100, "failed": 12, "recipients": 3})
    assert state == "dead-numbers"
    assert "list decay" in detail


def test_the_same_failures_spread_wide_is_a_blocked_sender():
    state, detail = sender_verdict({"total": 100, "failed": 30, "recipients": 30})
    assert state == "sender-blocked"
    assert "fifth" in detail


def test_a_thin_wide_spread_is_ordinary_handsets():
    state, detail = sender_verdict({"total": 500, "failed": 5, "recipients": 5})
    assert state == "handsets"
    assert "one retry each" in detail
