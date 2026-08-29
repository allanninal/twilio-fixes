from twilio_filtered_messages_audit import error_code, tally, verdict


def filtered(sid, sender="+15550001111"):
    return {"sid": sid, "from": sender, "status": "undelivered",
            "error_code": 30007, "direction": "outbound-api"}


def delivered(sid, sender="+15550001111"):
    return {"sid": sid, "from": sender, "status": "delivered",
            "error_code": None, "direction": "outbound-api"}


def test_error_code_reads_strings_and_numbers_the_same():
    assert error_code({"error_code": 30007}) == 30007
    assert error_code({"error_code": "30007"}) == 30007
    assert error_code({"error_code": None}) is None
    assert error_code({}) is None


def test_tally_groups_on_the_messaging_service_when_there_is_one():
    rows = tally([
        {"sid": "SM1", "from": "+15550001111", "messaging_service_sid": "MG1",
         "status": "undelivered", "error_code": 30007},
        {"sid": "SM2", "from": "+15550002222", "messaging_service_sid": "MG1",
         "status": "delivered"},
    ])
    assert set(rows) == {"MG1"}
    assert rows["MG1"] == {"total": 2, "filtered": 1, "undelivered": 1,
                           "sids": ["SM1"]}


def test_tally_ignores_inbound_messages():
    rows = tally([{"sid": "SM1", "from": "+15559990000", "direction": "inbound",
                   "status": "received"}])
    assert rows == {}


def test_two_filtered_out_of_two_is_isolated_not_an_outage():
    # Support will not open a filtering review on fewer than three SIDs, so a
    # 100% rate on two messages is deliberately the quieter state.
    state, detail = verdict({"total": 2, "filtered": 2})
    assert state == "isolated"
    assert "at least 3" in detail


def test_a_sender_above_half_is_the_sender_not_the_wording():
    state, detail = verdict({"total": 10, "filtered": 8})
    assert state == "sender-blocked"
    assert "reputation" in detail


def test_a_low_but_real_rate_is_a_content_problem():
    state, detail = verdict({"total": 200, "filtered": 10})
    assert state == "filtering"
    assert "shorteners" in detail


def test_no_filtered_messages_is_clean():
    state, detail = verdict({"total": 500, "filtered": 0})
    assert state == "clean"
    assert "500" in detail


def test_sids_are_capped_at_the_three_support_asks_for():
    rows = tally([filtered("SM%d" % i) for i in range(9)])
    assert rows["+15550001111"]["sids"] == ["SM0", "SM1", "SM2"]
    assert rows["+15550001111"]["filtered"] == 9
    assert verdict(rows["+15550001111"])[0] == "sender-blocked"
    assert verdict(tally([delivered("SM9")])["+15550001111"])[0] == "clean"
