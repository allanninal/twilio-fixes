from twilio_validity_ceiling_audit import queue_seconds, verdict

DEFAULT = {"sid": "MG1", "friendly_name": "notifications", "validity_period": 36000}
TIGHT = {"sid": "MG2", "friendly_name": "passcodes", "validity_period": 300}


def test_queue_wait_is_parsed_from_rfc_2822_not_sliced():
    waited = queue_seconds({"date_created": "Mon, 24 Aug 2026 09:00:00 +0000",
                            "date_sent": "Mon, 24 Aug 2026 09:04:00 +0000"})
    assert waited == 240


def test_a_message_that_was_never_sent_measures_nothing():
    # None rather than 0: not measured and waited nothing are different facts.
    assert queue_seconds({"date_created": "Mon, 24 Aug 2026 09:00:00 +0000"}) is None
    assert queue_seconds({"date_created": "nonsense", "date_sent": "also nonsense"}) is None


def test_measured_late_deliveries_under_the_default_are_the_finding():
    state, detail = verdict(DEFAULT, {"sampled": 400, "late": 37, "worst": 5400}, True)
    assert state == "too-long"
    assert "5400s" in detail


def test_late_deliveries_outrank_a_missing_declaration():
    assert verdict(DEFAULT, {"sampled": 10, "late": 1, "worst": 900})[0] == "too-long"


def test_the_default_is_correct_for_traffic_declared_bulk():
    state, _ = verdict(DEFAULT, {"sampled": 900, "late": 90, "worst": 7200}, False)
    assert state == "bulk"


def test_time_critical_traffic_at_the_default_is_latent_even_with_a_clean_window():
    state, detail = verdict(DEFAULT, {"sampled": 500, "late": 0, "worst": 12}, True)
    assert state == "latent"
    assert "next backlog" in detail


def test_an_undeclared_service_asks_rather_than_guesses():
    assert verdict(DEFAULT, {"sampled": 500, "late": 0, "worst": 9})[0] == "undeclared"


def test_a_shorter_ceiling_points_at_the_other_failure():
    state, detail = verdict(TIGHT, {"sampled": 500, "late": 0, "worst": 9}, True)
    assert state == "capped"
    assert "30036" in detail


def test_an_unread_validity_period_is_never_guessed_at():
    assert verdict({"sid": "MG3"}, None, True)[0] == "unknown"
