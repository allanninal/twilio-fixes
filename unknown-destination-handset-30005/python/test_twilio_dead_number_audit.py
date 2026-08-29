from twilio_dead_number_audit import by_recipient, day, error_code, verdict


def dead(sid, to="+15557770001", when="Fri, 21 Aug 2026 19:14:22 +0000"):
    return {"sid": sid, "to": to, "from": "+15550001111", "status": "undelivered",
            "error_code": 30005, "date_sent": when, "direction": "outbound-api"}


def test_error_code_reads_strings_and_numbers_the_same():
    assert error_code({"error_code": 30005}) == 30005
    assert error_code({"error_code": "30005"}) == 30005
    assert error_code({"error_code": None}) is None
    assert error_code({}) is None


def test_day_parses_the_rfc_2822_form_the_messages_list_actually_returns():
    # A ten-character slice of this gives "Fri, 21 A" for every message ever
    # sent, which is what makes the distinct-day rule fail silently.
    assert day("Fri, 21 Aug 2026 19:14:22 +0000") == "2026-08-21"
    assert day("Mon, 03 Aug 2026 01:02:03 +0000") == "2026-08-03"


def test_day_also_accepts_an_iso_timestamp():
    assert day("2026-08-21T19:14:22Z") == "2026-08-21"


def test_day_returns_none_rather_than_a_wrong_answer():
    assert day(None) is None
    assert day("") is None
    assert day("Fri, 21 Xxx 2026 19:14:22 +0000") is None


def test_by_recipient_dedupes_days_and_keeps_them_sorted():
    rows = by_recipient([
        dead("SM1", when="Fri, 21 Aug 2026 19:14:22 +0000"),
        dead("SM2", when="Fri, 21 Aug 2026 22:00:00 +0000"),
        dead("SM3", when="Mon, 03 Aug 2026 08:00:00 +0000"),
    ])
    assert rows["+15557770001"]["days"] == ["2026-08-03", "2026-08-21"]
    assert rows["+15557770001"]["dead"] == 3


def test_by_recipient_drops_numbers_with_no_30005_and_ignores_inbound():
    rows = by_recipient([
        {"sid": "SM1", "to": "+15557770002", "status": "delivered",
         "error_code": None, "direction": "outbound-api"},
        {"sid": "SM2", "to": "+15557770003", "direction": "inbound",
         "status": "received"},
    ])
    assert rows == {}


def test_two_failures_on_separate_days_is_a_dead_number():
    state, detail = verdict({"dead": 2, "delivered": 0,
                             "days": ["2026-08-03", "2026-08-21"]})
    assert state == "dead"
    assert "Delete it" in detail


def test_a_delivery_in_the_window_overrides_the_failures():
    # Carriers reissue disconnected numbers. Deleting on the strength of an old
    # 30005 is how a live customer stops hearing from you.
    state, detail = verdict({"dead": 3, "delivered": 1,
                             "days": ["2026-08-03", "2026-08-21"]})
    assert state == "recovered"
    assert "Keep this one" in detail


def test_repeats_inside_one_day_are_a_retry_loop_not_evidence():
    state, detail = verdict({"dead": 5, "delivered": 0, "days": ["2026-08-21"]})
    assert state == "retry-loop"
    assert "30005 is not 30003" in detail


def test_a_single_failure_is_only_a_suspect():
    state, detail = verdict({"dead": 1, "delivered": 0, "days": ["2026-08-21"]})
    assert state == "suspect"
    assert "Lookup" in detail


def test_no_failures_at_all_is_clean():
    state, _ = verdict({"dead": 0, "delivered": 4, "days": []})
    assert state == "clean"
