"""Testes de sanidade do NumPy: arrays, álgebra linear e vetorização."""

import numpy as np


def test_import_and_version():
    major = int(np.__version__.split(".")[0])
    assert major >= 2


def test_vector_operations():
    a = np.array([1.0, 0.0, 0.0])
    b = np.array([0.0, 1.0, 0.0])
    np.testing.assert_allclose(np.cross(a, b), [0.0, 0.0, 1.0])
    assert np.dot(a, b) == 0.0
    assert np.linalg.norm(a + b) == np.sqrt(2)


def test_rotation_matrix_is_orthonormal():
    theta = np.radians(30)
    rz = np.array([
        [np.cos(theta), -np.sin(theta), 0.0],
        [np.sin(theta), np.cos(theta), 0.0],
        [0.0, 0.0, 1.0],
    ])
    np.testing.assert_allclose(rz @ rz.T, np.eye(3), atol=1e-15)
    np.testing.assert_allclose(np.linalg.det(rz), 1.0)


def test_solve_linear_system():
    a = np.array([[3.0, 1.0], [1.0, 2.0]])
    b = np.array([9.0, 8.0])
    np.testing.assert_allclose(np.linalg.solve(a, b), [2.0, 3.0])


def test_vectorized_norms():
    rng = np.random.default_rng(seed=42)
    vectors = rng.normal(size=(1000, 3))
    norms = np.linalg.norm(vectors, axis=1)
    assert norms.shape == (1000,)
    unit = vectors / norms[:, np.newaxis]
    np.testing.assert_allclose(np.linalg.norm(unit, axis=1), 1.0)
