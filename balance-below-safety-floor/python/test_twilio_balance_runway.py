from twilio_balance_runway import (daily_prices, median, price_of, runway_days,
                                   verdict)


def test_median_of_an_even_run_is_the_middle_pair():
    assert median([1.0, 2.0, 3.0, 4.0]) == 2.5
    assert median([3.0, 1.0, 2.0]) == 2.0
    assert median([]) == 0.0


def test_a_credit_day_is_clamped_rather_than_subtracted():
    assert price_of({"price": "-42.00"}) == 0.0
    assert price_of({"price": "12.50"}) == 12.5


def test_unparseable_prices_are_dropped_not_guessed():
    assert price_of({"price": None}) is None
    assert price_of({"price": "n/a"}) is None
    assert daily_prices([{"price": "4"}, {"price": "x"}, {}]) == [4.0]


def test_runway_is_undefined_at_a_zero_burn_rate():
    assert runway_days(100.0, 0.0) is None
    assert runway_days(100.0, 10.0) == 10.0


def test_a_missing_balance_is_reported_rather_than_assumed_healthy():
    state, _ = verdict(None, [{"price": "10"}])
    assert state == "unknown"


def test_a_zero_balance_is_already_the_suspension():
    state, detail = verdict(0.0, [10.0, 10.0])
    assert state == "empty"
    assert "20005" in detail


def test_an_account_with_no_spend_has_no_runway_to_compute():
    state, _ = verdict(500.0, [])
    assert state == "idle"


def test_under_one_median_day_is_critical():
    state, _ = verdict(5.0, [10.0, 10.0, 10.0])
    assert state == "critical"


def test_four_days_of_runway_is_below_a_seven_day_floor():
    state, detail = verdict(40.0, [10.0, 10.0, 10.0])
    assert state == "low"
    assert "4.0 days" in detail


def test_a_quiet_median_hides_a_day_bigger_than_the_whole_balance():
    state, detail = verdict(500.0, [1.0, 1.0, 900.0])
    assert state == "burst-exposed"
    assert "900.00" in detail


def test_a_balance_past_the_floor_and_past_the_busiest_day_is_fine():
    state, _ = verdict(10000.0, [10.0, 10.0, 12.0])
    assert state == "ok"
