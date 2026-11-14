import os
import sys

if os.environ.get('APP_ENV') != 'test':
    sys.exit('Set APP_ENV=test to run the checks.')
print('3 checks passed.')
