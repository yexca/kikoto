# Unreleased

<details>
<summary><strong>Operations and reliability</strong></summary>

- The Go toolchain is updated to 1.26.11, which fixes an HTTP/1 server crash
  caused by a race on request headers when a request body is size-limited
  (GO-2026-6859).

</details>
