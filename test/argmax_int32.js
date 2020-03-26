describe('CTS', function() {
  const assert = chai.assert;
  const nn = navigator.ml.getNeuralNetworkContext();

    it('check result for Argmax example/1-4', async function() {
    // For 'Argmax' example: examples_int32
    let model = await nn.createModel(options);
    let operandIndex = 0;

    let input0_value = [1, 2, 4, 3];
    let output_expect = [1, 0];

    let type1 = {type: nn.INT32};
    let type2 = {type: nn.TENSOR_INT32, dimensions: [2]};
    let type2_length = product(type2.dimensions);
    let type4 = {type: nn.TENSOR_INT32, dimensions: [2, 2]};
    let type4_length = product(type4.dimensions);

    let input0 = operandIndex++;
    model.addOperand(type4);
    let axis = operandIndex++;
    model.addOperand(type1);
    let output = operandIndex++;
    model.addOperand(type2);

    model.setOperandValue(axis, new Int32Array([1]));
    model.addOperation(nn.ARGMAX, [input0, axis], [output]);

    model.identifyInputsAndOutputs([input0], [output]);
    await model.finish();

    let compilation = await model.createCompilation();
    compilation.setPreference(getPreferenceCode(options.prefer));
    await compilation.finish();

    let execution = await compilation.createExecution();

    let input0_input = new Int32Array(input0_value);
    execution.setInput(0, input0_input);
    let output_output = new Int32Array(type2_length);
    execution.setOutput(0, output_output);

    await execution.startCompute();

    for (let i = 0; i < type2_length; ++i) {
      assert.isTrue(almostEqualCTS(output_output[i], output_expect[i]));
    }
  });

    it('check result for Argmax example/2-4', async function() {
    // For 'Argmax' example: examples_int32
    let model = await nn.createModel(options);
    let operandIndex = 0;

    let input0_value = [1, 2, 4, 3];
    let output_expect = [1, 1];

    let type1 = {type: nn.INT32};
    let type2 = {type: nn.TENSOR_INT32, dimensions: [2]};
    let type2_length = product(type2.dimensions);
    let type4 = {type: nn.TENSOR_INT32, dimensions: [2, 2]};
    let type4_length = product(type4.dimensions);

    let input0 = operandIndex++;
    model.addOperand(type4);
    let axis = operandIndex++;
    model.addOperand(type1);
    let output = operandIndex++;
    model.addOperand(type2);

    model.setOperandValue(axis, new Int32Array([0]));
    model.addOperation(nn.ARGMAX, [input0, axis], [output]);

    model.identifyInputsAndOutputs([input0], [output]);
    await model.finish();

    let compilation = await model.createCompilation();
    compilation.setPreference(getPreferenceCode(options.prefer));
    await compilation.finish();

    let execution = await compilation.createExecution();

    let input0_input = new Int32Array(input0_value);
    execution.setInput(0, input0_input);
    let output_output = new Int32Array(type2_length);
    execution.setOutput(0, output_output);

    await execution.startCompute();

    for (let i = 0; i < type2_length; ++i) {
      assert.isTrue(almostEqualCTS(output_output[i], output_expect[i]));
    }
  });

    it('check result for Argmax example/3-4', async function() {
    // For 'Argmax' example: examples_int32
    let model = await nn.createModel(options);
    let operandIndex = 0;

    let input0_value = [1, 2, 4, 3];
    let output_expect = [1, 0];

    let type1 = {type: nn.INT32};
    let type2 = {type: nn.TENSOR_INT32, dimensions: [2]};
    let type2_length = product(type2.dimensions);
    let type4 = {type: nn.TENSOR_INT32, dimensions: [2, 2]};
    let type4_length = product(type4.dimensions);

    let input0 = operandIndex++;
    model.addOperand(type4);
    let axis = operandIndex++;
    model.addOperand(type1);
    let output = operandIndex++;
    model.addOperand(type2);

    model.setOperandValue(axis, new Int32Array([-1]));
    model.addOperation(nn.ARGMAX, [input0, axis], [output]);

    model.identifyInputsAndOutputs([input0], [output]);
    await model.finish();

    let compilation = await model.createCompilation();
    compilation.setPreference(getPreferenceCode(options.prefer));
    await compilation.finish();

    let execution = await compilation.createExecution();

    let input0_input = new Int32Array(input0_value);
    execution.setInput(0, input0_input);
    let output_output = new Int32Array(type2_length);
    execution.setOutput(0, output_output);

    await execution.startCompute();

    for (let i = 0; i < type2_length; ++i) {
      assert.isTrue(almostEqualCTS(output_output[i], output_expect[i]));
    }
  });
})
