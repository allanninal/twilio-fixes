from twilio_deactivations_audit import load_contacts, normalize, reconcile, verdict


def test_every_common_contact_format_normalises_to_one_key():
    for raw in ["+14155550100", "(415) 555-0100", "415-555-0100",
                " +1 415 555 0100 ", "1 (415) 555 0100"]:
        assert normalize(raw) == "+14155550100"


def test_a_non_us_number_keeps_its_own_country_code():
    assert normalize("+44 20 7946 0100") == "+442079460100"


def test_junk_and_short_numbers_are_dropped_rather_than_guessed():
    assert normalize("") is None
    assert normalize(None) is None
    assert normalize("not a number") is None
    assert normalize("5550100") is None


def test_reconcile_matches_across_different_formats():
    # The whole point: the feed is E.164 and the contact table is not.
    contacts = load_contacts([
        {"number": "(415) 555-0100", "last_sent_at": None},
        {"number": "415-555-0199"},
    ])
    deactivations = {"+14155550100": "2026-08-01"}
    matches = reconcile(deactivations, contacts)
    assert [m["number"] for m in matches] == ["+14155550100"]
    assert matches[0]["deactivated_on"] == "2026-08-01"


def test_sending_after_the_deactivation_date_is_an_incident():
    state, detail = verdict({"number": "+14155550100",
                             "deactivated_on": "2026-08-01",
                             "last_sent_at": "2026-08-14T09:12:00Z"})
    assert state == "misdelivered"
    assert "access-control incident" in detail


def test_a_send_before_the_deactivation_is_only_at_risk():
    state, _ = verdict({"number": "+14155550100",
                        "deactivated_on": "2026-08-01",
                        "last_sent_at": "2026-07-30"})
    assert state == "at-risk"


def test_a_match_with_no_sends_is_still_at_risk():
    state, detail = verdict({"number": "+14155550100",
                             "deactivated_on": "2026-08-01",
                             "last_sent_at": None})
    assert state == "at-risk"
    assert "consent record" in detail


def test_an_already_suppressed_match_is_not_reported_as_a_problem():
    state, _ = verdict({"number": "+14155550100", "deactivated_on": "2026-08-01",
                        "last_sent_at": "2026-08-14", "suppressed": True})
    assert state == "suppressed"
