#!/usr/bin/env sh
# Creates a throwaway CA and a "localhost" server certificate for test/tls_test.ts.
# Usage: sh test/gen_test_cert.sh <output-dir>
# Then: SMTPWIRE_TEST_CA=<dir>/ca.pem SMTPWIRE_TEST_CERT=<dir>/cert.pem \
#       SMTPWIRE_TEST_KEY=<dir>/key.pem deno task test
# Keep the output directory outside the repository; never commit the keys.
set -eu
out="${1:?output directory required}"
mkdir -p "$out"
cd "$out"
export MSYS_NO_PATHCONV=1
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 \
  -subj "/CN=smtpwire test CA" -keyout ca-key.pem -out ca.pem 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -subj "/CN=localhost" -keyout key.pem -out server.csr 2>/dev/null
printf 'subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' > ext.cnf
openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 2 \
  -extfile ext.cnf -out cert.pem 2>/dev/null
rm -f server.csr ext.cnf ca.srl ca-key.pem
echo "wrote ca.pem, cert.pem and key.pem to $out"
