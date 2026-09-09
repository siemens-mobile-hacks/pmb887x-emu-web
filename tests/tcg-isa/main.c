#include "harness.h"

void t_arith(void);
void t_logic(void);
void t_shift(void);
void t_mul(void);
void t_clz(void);
void t_psr(void);
void t_ldst(void);
void t_block(void);
void t_swp(void);
void t_sat(void);
void t_interwork(void);
void t_smc(void);
void t_memstress(void);

int tcgisa_main(void)
{
    uart_puts("# tcg-isa op-suite v1 (doc/wasm-tcg-backend-plan.md, phase 0a)\n");

    t_arith();
    t_logic();
    t_shift();
    t_mul();
    t_clz();
    t_psr();
    t_ldst();
    t_block();
    t_swp();
    t_sat();
    t_interwork();
    t_smc();
    t_memstress();

    suite_plan();
    return suite_fail != 0;
}
