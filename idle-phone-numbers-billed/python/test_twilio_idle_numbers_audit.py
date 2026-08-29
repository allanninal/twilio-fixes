from twilio_idle_numbers_audit import monthly_rate, verdict

NOTHING = {"outbound_messages": 0, "inbound_messages": 0,
           "outbound_calls": 0, "inbound_calls": 0}


def test_silent_number_is_idle_and_priced_for_the_year():
    state, detail, annual = verdict(NOTHING, 1.15)
    assert state == "idle"
    assert round(annual, 2) == 13.80
    assert "13.80" in detail


def test_expensive_idle_number_is_escalated():
    # A toll-free number rents for more, so it is the one to release first.
    state, _, annual = verdict(NOTHING, 2.15, flag_above=24.0)
    assert state == "idle-costly"
    assert annual > 24.0


def test_inbound_only_number_is_not_reported_as_idle():
    # Checking From= alone is how somebody releases a working support line.
    act = dict(NOTHING, inbound_calls=31)
    state, detail, _ = verdict(act, 1.15)
    assert state == "inbound-only"
    assert "confirm before releasing" in detail


def test_a_handful_of_messages_reports_cost_per_message():
    act = dict(NOTHING, outbound_messages=3)
    state, detail, _ = verdict(act, 1.15, window_days=90, min_traffic=5)
    assert state == "trickle"
    assert "per message or call" in detail


def test_busy_number_is_active():
    act = dict(NOTHING, outbound_messages=50, inbound_messages=12)
    state, _, _ = verdict(act, 1.15)
    assert state == "active"


def test_monthly_rate_uses_the_newest_month_and_divides_by_the_numbers():
    records = [
        {"category": "phonenumbers", "start_date": "2026-06-01", "price": "23.00"},
        {"category": "phonenumbers", "start_date": "2026-07-01", "price": "46.00"},
    ]
    assert monthly_rate(records, 40) == 1.15


def test_monthly_rate_takes_the_magnitude_of_a_signed_price():
    records = [{"category": "phonenumbers", "start_date": "2026-07-01",
                "price": "-46.00"}]
    assert monthly_rate(records, 40) == 1.15


def test_monthly_rate_override_wins_and_survives_an_empty_account():
    assert monthly_rate([], 0, override=2.0) == 2.0
    assert monthly_rate([], 0) == 0.0
