// Small dense linear algebra for symmetric positive-definite matrices (dimension n, here 6).
// Pure functions, no dependencies.

export type Mat = number[][];
export type Vec = number[];

export function identity(n: number): Mat {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}

export function cloneMat(M: Mat): Mat {
  return M.map((row) => row.slice());
}

export function matVec(M: Mat, v: Vec): Vec {
  return M.map((row) => row.reduce((acc, a, j) => acc + a * (v[j] as number), 0));
}

export function dot(a: Vec, b: Vec): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

/** Lower-triangular L with A = L L^T. Throws if A is not (numerically) positive definite. */
export function cholesky(A: Mat): Mat {
  const n = A.length;
  const L: Mat = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = (A[i] as Vec)[j] as number;
      for (let k = 0; k < j; k++) sum -= (L[i] as Vec)[k]! * (L[j] as Vec)[k]!;
      if (i === j) {
        if (!(sum > 0) || !Number.isFinite(sum)) {
          throw new Error('[AdaptiveEngine] matrix is not positive definite');
        }
        (L[i] as Vec)[j] = Math.sqrt(sum);
      } else {
        (L[i] as Vec)[j] = sum / ((L[j] as Vec)[j] as number);
      }
    }
  }
  return L;
}

/** Solves L y = b (L lower triangular). */
export function forwardSub(L: Mat, b: Vec): Vec {
  const n = L.length;
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i] as number;
    for (let k = 0; k < i; k++) s -= (L[i] as Vec)[k]! * y[k]!;
    y[i] = s / ((L[i] as Vec)[i] as number);
  }
  return y;
}

/** Solves L^T x = y (L lower triangular, so L^T is upper triangular). */
export function backSubT(L: Mat, y: Vec): Vec {
  const n = L.length;
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i] as number;
    for (let k = i + 1; k < n; k++) s -= (L[k] as Vec)[i]! * x[k]!;
    x[i] = s / ((L[i] as Vec)[i] as number);
  }
  return x;
}

/** Solves A x = b given L = cholesky(A). */
export function solveWithCholesky(L: Mat, b: Vec): Vec {
  return backSubT(L, forwardSub(L, b));
}

/** A^-1 given L = cholesky(A). */
export function inverseFromCholesky(L: Mat): Mat {
  const n = L.length;
  const inv: Mat = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let j = 0; j < n; j++) {
    const e = new Array<number>(n).fill(0);
    e[j] = 1;
    const col = solveWithCholesky(L, e);
    for (let i = 0; i < n; i++) (inv[i] as Vec)[j] = col[i] as number;
  }
  return inv;
}

export function isSymmetric(M: Mat, tol = 1e-9): boolean {
  for (let i = 0; i < M.length; i++) {
    for (let j = i + 1; j < M.length; j++) {
      const a = (M[i] as Vec)[j] as number;
      const b = (M[j] as Vec)[i] as number;
      if (Math.abs(a - b) > tol * (1 + Math.abs(a) + Math.abs(b))) return false;
    }
  }
  return true;
}
