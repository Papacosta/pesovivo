"""Testes da agregação do modo passagem (mediana + descarte de discrepantes)."""
import pytest

from app.services.passages import aggregate_estimates, robust_sigma


def test_mediana_dos_quadros_e_faixa_do_modelo():
    agg = aggregate_estimates([410.0, 415.0, 412.0, 418.0], model_half_width=25.0)
    assert agg.weight_kg == pytest.approx(413.5)
    assert agg.interval_half_width_kg == 25.0
    assert agg.weight_min_kg == pytest.approx(388.5)
    assert agg.weight_max_kg == pytest.approx(438.5)
    assert agg.n_used == 4
    assert agg.warnings == []


def test_descarta_quadro_discrepante():
    agg = aggregate_estimates([410.0, 412.0, 414.0, 600.0], model_half_width=25.0)
    assert agg.used_mask == [True, True, True, False]
    assert agg.weight_kg == pytest.approx(412.0)
    assert any("discrepante" in w for w in agg.warnings)


def test_quadros_sem_estimativa_sao_ignorados():
    agg = aggregate_estimates([None, 400.0, None, 404.0], model_half_width=20.0)
    assert agg.used_mask == [False, True, False, True]
    assert agg.weight_kg == pytest.approx(402.0)


def test_sem_quadro_valido():
    agg = aggregate_estimates([None, None], model_half_width=20.0)
    assert agg.weight_kg is None
    assert agg.n_used == 0
    assert agg.warnings


def test_um_quadro_avisa_instabilidade():
    agg = aggregate_estimates([420.0], model_half_width=20.0)
    assert agg.weight_kg == pytest.approx(420.0)
    assert agg.spread_kg == 0.0
    assert any("1 quadro" in w for w in agg.warnings)


def test_quadros_muito_dispersos_alargam_a_faixa():
    # Dispersão grande, mas sem discrepante isolado (distribuição larga).
    agg = aggregate_estimates([360.0, 390.0, 420.0, 450.0, 480.0], model_half_width=15.0)
    assert agg.n_used == 5
    assert agg.interval_half_width_kg > 15.0
    assert any("faixa alargada" in w for w in agg.warnings)


def test_quadros_identicos_nao_descartam_nada():
    agg = aggregate_estimates([400.0, 400.0, 400.0, 401.0], model_half_width=20.0)
    assert agg.n_used == 4


def test_robust_sigma():
    assert robust_sigma([]) == 0.0
    assert robust_sigma([1.0, 1.0, 1.0]) == 0.0
    assert robust_sigma([1.0, 2.0, 3.0, 4.0, 100.0]) == pytest.approx(1.4826, rel=1e-3)


def test_faixa_maior_com_celular_na_mao():
    from app.services.passages import HANDHELD_INTERVAL_FACTOR, passage_half_width

    assert passage_half_width(20.0, "fixed") == 20.0
    assert passage_half_width(20.0, "handheld") == pytest.approx(20.0 * HANDHELD_INTERVAL_FACTOR)


def test_categoria_escolhida_so_completa_o_cadastro():
    from types import SimpleNamespace

    from app.services.passages import animal_features

    assert animal_features(None, "novilha") == {"category": "novilha"}
    assert animal_features(None, None) == {}
    animal = SimpleNamespace(breed="nelore", sex="macho", category="boi", age_months=24, bcs=None)
    assert animal_features(animal, "bezerro")["category"] == "boi"
    animal.category = None
    assert animal_features(animal, "bezerro")["category"] == "bezerro"
